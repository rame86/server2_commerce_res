// src/messaging/listener/eventResponseConsumer.js
const amqp = require('amqplib');
const eventService = require('../../services/eventService'); // 서비스 불러오기
const { EXCHANGE, QUEUES, ROUTING_KEYS } = require('../../config/rabbitMQ');

async function startEventResponseConsumer() {
    const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        await channel.assertQueue(QUEUES.EVENT_RES_CORE, { durable: true });
        await channel.bindQueue(QUEUES.EVENT_RES_CORE, EXCHANGE, ROUTING_KEYS.EVENT_RES_CORE);

        channel.consume(QUEUES.EVENT_RES_CORE, async (msg) => {
            if (!msg) return;
            try {
                const response = JSON.parse(msg.content.toString());
                console.log(`📩 [수신] 관리자 응답 도착: ID ${response.approvalId}, 상태: ${response.status}`);
                
                // 🌟 서비스 호출 (한 줄로 끝!)
                await eventService.processAdminResponse(response);

                channel.ack(msg);
            } catch (err) {
                console.error("❌ 처리 오류:", err.message);
                channel.nack(msg, false, false);
            }
        });
    } catch (err) {
        console.error("❌ MQ 연결 실패:", err);
    }
}

module.exports = startEventResponseConsumer;