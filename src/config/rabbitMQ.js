// src/config/rabbitMQ.js
const amqp = require('amqplib');
require('dotenv').config();

let channel = null;

// 큐 이름 정의 (중앙 관리로 하드코딩 방지)
const QUEUES = {
    RESERVATION: 'reservation.queue',
    REFUND_REQUEST: 'refund.request.queue',
    STATUS_UPDATE: 'res.status.update.queue',
    CANCEL: 'reservation.cancel.queue',
    PAY_REQUEST: 'pay.request.queue'
};

// 라우팅 키 정의 (메시지가 전달될 주소 이름표)
const ROUTING_KEYS = {
    PAY_REQUEST: 'pay.request',
    STATUS_UPDATE: 'res.status.update'
};

// 모든 서비스가 공용으로 사용할 익스체인지 이름
const EXCHANGE = 'msa.direct.exchange';

/**
 * RabbitMQ 서버에 연결하고 채널 및 익스체인지를 초기화해.
 */
const connectRabbitMQ = async () => {
    try {
        const mqUser = process.env.RABBITMQ_USER;
        const mqPass = process.env.RABBITMQ_PASSWORD; 
        const mqHost = process.env.RABBITMQ_HOST;
        const rabbitUrl = `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

        const connection = await amqp.connect(rabbitUrl);
        channel = await connection.createChannel();
        
        // Direct 방식의 익스체인지를 생성해 (라우팅 키가 정확히 일치해야 함)
        await channel.assertExchange(EXCHANGE, 'direct', { durable: true });
        console.log("✅ RabbitMQ 채널 및 익스체인지 연결 성공");
    } catch (error) {
        console.error("❌ RabbitMQ 연결 실패:", error);
    }
};

/**
 * 메시지를 특정 라우팅 키를 가진 익스체인지로 발행해.
 */
const publishToQueue = async (routingKey, message) => {
    if (!channel) {
        console.error("❌ RabbitMQ 채널이 준비되지 않아 메시지를 보낼 수 없어.");
        return;
    }
    
    // 객체를 버퍼(Buffer)로 변환해서 전송해
    channel.publish(
        EXCHANGE, 
        routingKey, 
        Buffer.from(JSON.stringify(message)), 
        { persistent: true } // 서버가 꺼져도 메시지가 유지되도록 설정
    );
};

module.exports = { connectRabbitMQ, publishToQueue, QUEUES, ROUTING_KEYS, EXCHANGE };