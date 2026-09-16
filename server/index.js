const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../repo')));

const db = new sqlite3.Database('./findit.db');

// Schema setup
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    category TEXT,
    itemDescription TEXT,
    colour TEXT,
    location TEXT,
    date TEXT,
    time TEXT,
    contactDetails TEXT,
    status TEXT DEFAULT 'Open',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  )`);
});

// Seed admin user (use env for security)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';

bcrypt.hash(ADMIN_PASSWORD, 10).then(hash => {
  db.run(`INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)`, [ADMIN_USERNAME, hash]);
});

// API Routes
app.post('/reports', (req, res) => {
  const { type, category, itemDescription, colour, location, date, time, contactDetails } = req.body;
  db.run(`INSERT INTO reports (type, category, itemDescription, colour, location, date, time, contactDetails) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [type, category, itemDescription, colour, location, date, time, contactDetails],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: this.lastID });
    });
});

app.get('/reports', (req, res) => {
  db.all(`SELECT * FROM reports`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Admin Login
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ username }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
    res.json({ token });
  });
});

// Admin Update Status
app.patch('/admin/reports/:id', (req, res) => {
    // Basic auth check
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token.split(' ')[1], process.env.JWT_SECRET || 'secret', (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Unauthorized' });
        
        const { status } = req.body;
        db.run(`UPDATE reports SET status = ? WHERE id = ?`, [status, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Report updated' });
        });
    });
});

// Retention Cron Job: Delete older than 7 days
cron.schedule('0 0 * * *', () => {
    db.run(`DELETE FROM reports WHERE createdAt < datetime('now', '-7 days')`);
    console.log('Retention task: Deleted old reports.');
});

app.listen(3000, () => console.log('Server running on port 3000'));
