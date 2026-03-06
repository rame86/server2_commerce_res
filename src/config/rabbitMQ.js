// src/config/rabbitMQ.js

const amqp = require('amqplib');
require('dotenv').config();

let channel = null;

// 핵심 주석: 앱 실행 시 한 번만 호출하여 커넥션 풀처럼 사용 (하드코딩 배제)
const connectRabbitMQ = async () => {
    try {
        const mqUser = process.env.RABBITMQ_USER;
        const mqPass = process.env.RABBITMQ_PASSWORD;
        const mqHost = process.env.RABBITMQ_HOST;
        const rabbitUrl = `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

        const connection = await amqp.connect(rabbitUrl);
        channel = await connection.createChannel();
        console.log("✅ RabbitMQ 채널 연결 성공");
    } catch (error) {
        console.error("❌ RabbitMQ 연결 실패:", error);
    }
};

// 핵심 주석: 큐 이름과 메시지를 받아 전송만 담당하는 공통 함수
const publishToQueue = async (queueName, message) => {
    if (!channel) throw new Error("RabbitMQ 채널이 아직 준비되지 않았어.");
    
    await channel.assertQueue(queueName, { durable: true });
    // persistent: true를 통해 메시지가 디스크에 저장되도록 하여 유실 방지
    channel.sendToQueue(queueName, Buffer.from(JSON.stringify(message)), { persistent: true });
};

module.exports = { connectRabbitMQ, publishToQueue };