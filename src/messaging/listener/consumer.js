// src/messaging/listener/consumer.js
const amqp = require('amqplib');
const { QUEUES, EXCHANGE, ROUTING_KEYS } = require('../../config/rabbitMQ');

async function startConsumer() {
    const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        // 1. 큐 생성
        await channel.assertQueue(QUEUES.RESERVATION, { durable: true });
        await channel.assertQueue(QUEUES.REFUND_REQUEST, { durable: true });
        await channel.assertQueue(QUEUES.PAY_REQUEST, { durable: true });

        // 🚨 2. 내가 빼먹었던 부분! 우체국(Exchange)과 큐를 연결해주는 바인딩 설정
        await channel.bindQueue(QUEUES.RESERVATION, EXCHANGE, QUEUES.RESERVATION);
        await channel.bindQueue(QUEUES.REFUND_REQUEST, EXCHANGE, QUEUES.REFUND_REQUEST);
        await channel.bindQueue(QUEUES.PAY_REQUEST, EXCHANGE, ROUTING_KEYS.PAY_REQUEST);

        console.log(`👷 [Consumer] 구독 중: ${QUEUES.RESERVATION}, ${QUEUES.REFUND_REQUEST}`);

        // A. 예약 요청 처리
        channel.consume(QUEUES.RESERVATION, async (msg) => {
            if (!msg) return;
            const data = JSON.parse(msg.content.toString());
            
            try {
                const paymentData = {
                    orderId: data.ticket_code,
                    memberId: data.member_id,
                    amount: data.total_price,
                    type: "PAYMENT",
                    replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
                };

                console.log("🚀 [MQ 전송 직전 데이터]:", JSON.stringify(paymentData, null, 2));

                channel.publish(
                    EXCHANGE, 
                    ROUTING_KEYS.PAY_REQUEST, 
                    Buffer.from(JSON.stringify(paymentData)), 
                    { 
                        persistent: true,
                        contentType: 'application/json' // 🚨 핵심! Spring이 읽을 수 있게 해줌
                    }
                );

                channel.ack(msg);
            } catch (err) {
                console.error("❌ 예약 처리 에러:", err.message);
                channel.nack(msg, false, false);
            }
        });

        // B. 환불 요청 처리
        channel.consume(QUEUES.REFUND_REQUEST, async (msg) => {
            if (!msg) return;
            const data = JSON.parse(msg.content.toString());
            
            try {
                const refundData = {
                    orderId: data.ticket_code,
                    memberId: data.member_id,
                    amount: data.cancel_amount,
                    type: "REFUND",
                    replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
                };

                channel.publish(
                    EXCHANGE, 
                    ROUTING_KEYS.PAY_REQUEST, 
                    Buffer.from(JSON.stringify(refundData)), 
                    { 
                        persistent: true,
                        contentType: 'application/json' // 🚨 환불 쪽에도 꼭 추가!
                    }
                );
                
                channel.ack(msg);
            } catch (err) {
                console.error("❌ 환불 처리 에러:", err.message);
                channel.nack(msg, false, false);
            }
        });

    } catch (err) {
        console.error("❌ RabbitMQ Consumer 연결 실패:", err);
    }
}

module.exports = startConsumer;