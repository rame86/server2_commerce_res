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
    PAY_REQUEST: 'pay.request.queue',
    // 🌟 관리자로부터 승인 결과를 받을 내 큐
    EVENT_RES_CORE: 'event.res.core.queue'
};

// 라우팅 키 정의 (메시지가 전달될 주소 이름표)
const ROUTING_KEYS = {
    PAY_REQUEST: 'pay.request',
    STATUS_UPDATE: 'res.status.update',
    // 🌟 내가 관리자에게 승인 요청을 보낼 때 쓰는 키
    EVENT_REQ_ADMIN: 'admin.event.request',
    // 🌟 관리자가 나에게 결과를 보내줄 때 쓰는 키
    EVENT_RES_CORE: 'event.res.core'
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

        // 🌟 내 큐 생성 및 바인딩 (관리자가 보내는 응답을 듣기 위해)
        await channel.assertQueue(QUEUES.EVENT_RES_CORE, { durable: true });
        await channel.bindQueue(QUEUES.EVENT_RES_CORE, EXCHANGE, ROUTING_KEYS.EVENT_RES_CORE);

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
        {persistent: true,
            contentType: 'application/json'} // 서버가 꺼져도 메시지가 유지되도록 설정
    );
};

// 🌟 추가: 관리자 응답을 처리하는 컨슈머 (리스너)
// src/config/rabbitMQ.js 의 consumeAdminResponse 수정

const consumeAdminResponse = async (callback) => {
    // 채널이 아직 없으면 대기하거나 에러 출력
    if (!channel) {
        console.error("❌ 채널이 아직 준비되지 않았어. 연결을 기다리는 중...");
        return;
    }

    console.log(`📡 [리스너 대기 중] 큐: ${QUEUES.EVENT_RES_CORE}`);

    channel.consume(QUEUES.EVENT_RES_CORE, async (msg) => {
        if (msg !== null) {
            try {
                const content = JSON.parse(msg.content.toString());
                console.log("📥 [MQ 수신 성공]:", content); // 🌟 여기가 찍히는지 확인이 제일 중요!
                
                await callback(content); 
                channel.ack(msg);
            } catch (err) {
                console.error("❌ 메시지 처리 중 오류:", err);
                // 오류 시 다시 큐로 넣지 않고 버림 (무한루프 방지)
                channel.nack(msg, false, false);
            }
        }
    });
};

module.exports = { 
    connectRabbitMQ, 
    publishToQueue, 
    consumeAdminResponse,
    QUEUES, 
    ROUTING_KEYS, 
    EXCHANGE 
};