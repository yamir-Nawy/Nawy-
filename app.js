// ─────────────────────────────────────────────────────────────────────────────
// db.js  –  Railway MySQL connection pool & query helpers
// ─────────────────────────────────────────────────────────────────────────────
const mysql = require('mysql2/promise');

const dbConfig = {
    host:     process.env.MYSQLHOST     || 'your-railway-host.railway.app',
    port:     process.env.MYSQLPORT     || 3306,
    user:     process.env.MYSQLUSER     || 'root',
    password: process.env.MYSQLPASSWORD || 'your-password',
    database: process.env.MYSQLDATABASE || 'railway',
    ssl: { rejectUnauthorized: false }
};

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Railway MySQL Connected');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Connection Failed:', error.message);
        return false;
    }
}

const db = {
    async initTables() {
        const createAgentsTable = `
            CREATE TABLE IF NOT EXISTS agents (
                id         INT PRIMARY KEY AUTO_INCREMENT,
                name       VARCHAR(100) NOT NULL,
                email      VARCHAR(100) UNIQUE NOT NULL,
                \`group\`  CHAR(1)      NOT NULL CHECK (\`group\` IN ('A', 'B', 'C')),
                status     VARCHAR(20)  DEFAULT 'active',
                created_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
            )
        `;

        const createSchedulesTable = `
            CREATE TABLE IF NOT EXISTS schedules (
                id            INT PRIMARY KEY AUTO_INCREMENT,
                schedule_date DATE        NOT NULL,
                shift         ENUM('morning', 'night') NOT NULL,
                agent_id      INT         NOT NULL,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
                UNIQUE KEY unique_schedule (schedule_date, shift, agent_id)
            )
        `;

        try {
            await pool.query(createAgentsTable);
            await pool.query(createSchedulesTable);
            console.log('✅ Tables initialized');
        } catch (error) {
            console.error('❌ Table creation failed:', error);
        }
    },

    async getAllAgents() {
        const [rows] = await pool.query('SELECT * FROM agents ORDER BY id');
        return rows;
    },

    async createAgent(agent) {
        const [result] = await pool.query(
            'INSERT INTO agents (name, email, `group`, status) VALUES (?, ?, ?, ?)',
            [agent.name, agent.email, agent.group, agent.status || 'active']
        );
        return result.insertId;
    },

    async updateAgentGroup(agentId, group) {
        await pool.query('UPDATE agents SET `group` = ? WHERE id = ?', [group, agentId]);
    },

    async saveSchedule(scheduleDate, shift, agentId) {
        await pool.query(
            `INSERT INTO schedules (schedule_date, shift, agent_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE agent_id = VALUES(agent_id)`,
            [scheduleDate, shift, agentId]
        );
    },

    async getScheduleByDateRange(startDate, endDate) {
        const [rows] = await pool.query(
            `SELECT s.*, a.name AS agent_name, a.\`group\` AS agent_group
             FROM schedules s
             JOIN agents a ON s.agent_id = a.id
             WHERE s.schedule_date BETWEEN ? AND ?
             ORDER BY s.schedule_date, s.shift`,
            [startDate, endDate]
        );
        return rows;
    },

    async close() {
        await pool.end();
    }
};

module.exports = { pool, db, testConnection };


// ─────────────────────────────────────────────────────────────────────────────
// app.js  –  Express REST API
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const cors    = require('cors');
const { db: database, testConnection: connect } = require('./db'); // adjust path if split

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET  /api/agents  –  return all agents
app.get('/api/agents', async (req, res) => {
    try {
        const agents = await database.getAllAgents();
        res.json({ success: true, agents });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/agents  –  create a new agent
app.post('/api/agents', async (req, res) => {
    try {
        const agentId = await database.createAgent(req.body);
        res.status(201).json({ success: true, agentId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// PATCH /api/agents/:id/group  –  reassign an agent's group
app.patch('/api/agents/:id/group', async (req, res) => {
    try {
        const { group } = req.body;
        if (!['A', 'B', 'C'].includes(group)) {
            return res.status(400).json({ success: false, error: 'group must be A, B, or C' });
        }
        await database.updateAgentGroup(req.params.id, group);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/schedules  –  bulk-save a generated schedule
// Body: { schedules: [{ date, shift, agentId }, ...] }
app.post('/api/schedules', async (req, res) => {
    try {
        const { schedules } = req.body;
        if (!Array.isArray(schedules) || schedules.length === 0) {
            return res.status(400).json({ success: false, error: 'schedules array is required' });
        }
        for (const sched of schedules) {
            await database.saveSchedule(sched.date, sched.shift, sched.agentId);
        }
        res.json({ success: true, message: `${schedules.length} schedule entries saved` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET  /api/schedules?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
app.get('/api/schedules', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            return res.status(400).json({ success: false, error: 'startDate and endDate are required' });
        }
        const schedules = await database.getScheduleByDateRange(startDate, endDate);
        res.json({ success: true, schedules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function startServer() {
    const connected = await connect();
    if (connected) {
        await database.initTables();
    } else {
        console.warn('⚠️  Running without DB – fix connection env vars and restart.');
    }

    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

startServer();