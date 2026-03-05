// db.js - Railway MySQL Connection
const mysql = require('mysql2/promise');

// Railway MySQL Configuration
// Get these from your Railway dashboard after creating MySQL database
const dbConfig = {
    host: process.env.MYSQLHOST || 'your-railway-host.railway.app',
    port: process.env.MYSQLPORT || 3306,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'your-password',
    database: process.env.MYSQLDATABASE || 'railway',
    ssl: {
        rejectUnauthorized: false // Required for Railway
    }
};

// Create connection pool
const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test connection
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Railway MySQL Connected Successfully');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Railway MySQL Connection Failed:', error.message);
        return false;
    }
}

// Database operations
const db = {
    // Initialize tables
    async initTables() {
        const createAgentsTable = `
            CREATE TABLE IF NOT EXISTS agents (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                \`group\` CHAR(1) NOT NULL CHECK (\`group\` IN ('A', 'B')),
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `;

        const createTaskDistributionTable = `
            CREATE TABLE IF NOT EXISTS task_distribution (
                id INT PRIMARY KEY AUTO_INCREMENT,
                agent_id INT NOT NULL,
                shift ENUM('morning', 'night') NOT NULL,
                task_name VARCHAR(50) NOT NULL,
                assigned_date DATE NOT NULL,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
                UNIQUE KEY unique_task_assignment (agent_id, shift, task_name, assigned_date)
            )
        `;

        const createSchedulesTable = `
            CREATE TABLE IF NOT EXISTS schedules (
                id INT PRIMARY KEY AUTO_INCREMENT,
                schedule_date DATE NOT NULL,
                shift ENUM('morning', 'night') NOT NULL,
                agent_id INT NOT NULL,
                tasks TEXT,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
                UNIQUE KEY unique_schedule (schedule_date, shift, agent_id)
            )
        `;

        try {
            await pool.query(createAgentsTable);
            await pool.query(createTaskDistributionTable);
            await pool.query(createSchedulesTable);
            console.log('✅ Tables initialized');
        } catch (error) {
            console.error('❌ Table creation failed:', error);
        }
    },

    // Agent operations
    async getAllAgents() {
        const [rows] = await pool.query('SELECT * FROM agents ORDER BY id');
        return rows;
    },

    async createAgent(agent) {
        const [result] = await pool.query(
            'INSERT INTO agents (name, email, `group`, status) VALUES (?, ?, ?, ?)',
            [agent.name, agent.email, agent.group, agent.status]
        );
        return result.insertId;
    },

    async updateAgentGroup(agentId, group) {
        await pool.query('UPDATE agents SET `group` = ? WHERE id = ?', [group, agentId]);
    },

    // Task distribution operations
    async saveTaskDistribution(agentId, shift, tasks, date) {
        // Clear existing assignments for this agent/shift/date
        await pool.query(
            'DELETE FROM task_distribution WHERE agent_id = ? AND shift = ? AND assigned_date = ?',
            [agentId, shift, date]
        );

        // Insert new assignments
        for (const task of tasks) {
            await pool.query(
                'INSERT INTO task_distribution (agent_id, shift, task_name, assigned_date) VALUES (?, ?, ?, ?)',
                [agentId, shift, task.name, date]
            );
        }
    },

    async getTaskDistribution(date) {
        const [rows] = await pool.query(`
            SELECT td.*, a.name as agent_name, a.\`group\` as agent_group 
            FROM task_distribution td
            JOIN agents a ON td.agent_id = a.id
            WHERE td.assigned_date = ?
        `, [date]);
        return rows;
    },

    // Schedule operations
    async saveSchedule(scheduleDate, shift, agentId, tasks) {
        await pool.query(
            `INSERT INTO schedules (schedule_date, shift, agent_id, tasks) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE tasks = VALUES(tasks)`,
            [scheduleDate, shift, agentId, JSON.stringify(tasks)]
        );
    },

    async getScheduleByDateRange(startDate, endDate) {
        const [rows] = await pool.query(`
            SELECT s.*, a.name as agent_name, a.\`group\` as agent_group
            FROM schedules s
            JOIN agents a ON s.agent_id = a.id
            WHERE s.schedule_date BETWEEN ? AND ?
            ORDER BY s.schedule_date, s.shift
        `, [startDate, endDate]);
        return rows;
    },

    // Close pool
    async close() {
        await pool.end();
    }
};

module.exports = { pool, db, testConnection };
const express = require('express');
const cors = require('cors');
const { db, testConnection, initTables } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Initialize
async function startServer() {
    const connected = await testConnection();
    if (connected) {
        await initTables();
    }
    
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

// API Routes

// Get all agents
app.get('/api/agents', async (req, res) => {
    try {
        const agents = await db.getAllAgents();
        res.json({ success: true, agents });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create agent
app.post('/api/agents', async (req, res) => {
    try {
        const agentId = await db.createAgent(req.body);
        res.json({ success: true, agentId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Save task distribution
app.post('/api/task-distribution', async (req, res) => {
    try {
        const { agents, date } = req.body;
        const targetDate = date || new Date().toISOString().split('T')[0];
        
        for (const agent of agents) {
            if (agent.assignedTasks?.morning?.length > 0) {
                await db.saveTaskDistribution(agent.id, 'morning', agent.assignedTasks.morning, targetDate);
            }
            if (agent.assignedTasks?.night?.length > 0) {
                await db.saveTaskDistribution(agent.id, 'night', agent.assignedTasks.night, targetDate);
            }
        }
        
        res.json({ success: true, message: 'Task distribution saved' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get task distribution
app.get('/api/task-distribution', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().split('T')[0];
        const distribution = await db.getTaskDistribution(date);
        res.json({ success: true, distribution });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Save schedule
app.post('/api/schedules', async (req, res) => {
    try {
        const { schedules } = req.body;
        for (const sched of schedules) {
            await db.saveSchedule(sched.date, sched.shift, sched.agentId, sched.tasks);
        }
        res.json({ success: true, message: 'Schedule saved' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get schedules
app.get('/api/schedules', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const schedules = await db.getScheduleByDateRange(startDate, endDate);
        res.json({ success: true, schedules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

startServer();