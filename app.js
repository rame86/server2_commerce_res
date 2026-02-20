// app.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');

const app = express();
const PORT = process.env.PORT || 8082;

// DATABASE_URL이 없을 경우를 대비한 폴백 처리
const dbUrl = process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@34.158.208.117:5432/msa_core_db`;

const pool = new Pool({ connectionString: dbUrl });

let channel;
async function connectMQ() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await conn.createChannel();
    console.log("✅ RabbitMQ 연결 성공");
  } catch (err) {
    console.error("❌ MQ 연결 실패 (5초 후 재시도):", err.message);
    setTimeout(connectMQ, 5000); // 연결 실패해도 앱이 죽지 않게 재시도
  }
}

app.use(express.json());
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`🚀 Service running on port ${PORT}`);
  connectMQ();
});