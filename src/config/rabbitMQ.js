// src/config/rabbitMQ.js
const amqp = require('amqplib');
require('dotenv').config();

let connection = null; // 서비스 전체에서 공유할 물리적 연결(TCP)
let channel = null;    // 메시지 발행(Publish)을 담당하는 공용 채널

/**
 * 큐(Queue) 이름 정의
 * 메시지가 실제로 쌓여서 처리를 기다리는 물리적인 저장소야.
 */
const QUEUES = {
    // 사용자의 예약 요청 메시지가 쌓이는 저장소
    RESERVATION: 'reservation.queue',
    // 사용자의 환불 신청 데이터가 쌓이는 저장소
    REFUND_REQUEST: 'refund.request.queue',
    // 결제 결과에 따른 예약 상태 업데이트 메시지가 대기하는 저장소
    STATUS_UPDATE: 'res.status.update.queue',
    // 결제 실패 등 비상 상황 발생 시 재고 복구(Rollback) 메시지가 쌓이는 저장소
    CANCEL: 'reservation.cancel.queue',
    // 결제 서버로 보낼 결제 요청 데이터가 대기하는 저장소
    PAY_REQUEST: 'pay.request.queue',
    // 🌟 관리자가 처리한 이벤트 승인/반려 결과가 나(Core)에게 들어오는 저장소
    EVENT_RES_CORE: 'event.res.core.queue'
};

/**
 * 라우팅 키(Routing Key) 정의
 * 익스체인지(Exchange)가 메시지를 어떤 큐로 배달할지 결정하는 '우편 주소'야.
 */
const ROUTING_KEYS = {
    // 메시지를 결제 요청 큐로 정확히 배달하기 위한 주소
    PAY_REQUEST: 'pay.request',
    // 결제 완료/실패 상태 정보를 전달하기 위한 주소
    STATUS_UPDATE: 'res.status.update',
    // 🌟 내가 관리자(Admin)에게 "이 이벤트 검토해줘"라고 요청할 때 사용하는 주소
    EVENT_REQ_ADMIN: 'admin.event.request',
    // 🌟 관리자가 검토를 마치고 나(Core)에게 결과를 돌려줄 때 사용하는 주소
    EVENT_RES_CORE: 'event.res.core'
};

// 메시지를 분류해서 각 큐로 전달하는 중앙 우체국(Exchange) 이름
const EXCHANGE = 'msa.direct.exchange';

/**
 * [RabbitMQ 중앙 연결] 
 * 서버와 커넥션을 맺고 메시지 발행을 위한 기본 채널을 초기화해.
 */
const connectRabbitMQ = async () => {
    try {
        const mqUser = process.env.RABBITMQ_USER;
        const mqPass = process.env.RABBITMQ_PASSWORD; 
        const mqHost = process.env.RABBITMQ_HOST;
        const rabbitUrl = `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

        // 1. RabbitMQ 서버와 연결 생성
        connection = await amqp.connect(rabbitUrl);
        // 2. 공용 발행 채널 생성
        channel = await connection.createChannel();
        
        // 3. Direct 방식의 익스체인지 선언 (주소와 큐가 1:1로 매칭됨)
        await channel.assertExchange(EXCHANGE, 'direct', { durable: true });

        console.log("✅ RabbitMQ 커넥션 및 익스체인지 연결 성공");
    } catch (error) {
        console.error("❌ RabbitMQ 연결 실패:", error);
    }
};

/**
 * [공통 메시지 발행] 
 * 특정 라우팅 키(주소)를 붙여서 메시지를 익스체인지로 전송해.
 */
const publishToQueue = async (routingKey, message) => {
    if (!channel) {
        console.error("❌ RabbitMQ 채널이 준비되지 않았어.");
        return;
    }
    
    // JSON 데이터를 버퍼로 변환하여 전송 (서버 재시작 시에도 메시지 보존 설정)
    channel.publish(
        EXCHANGE, 
        routingKey, 
        Buffer.from(JSON.stringify(message)), 
        {
            persistent: true, 
            contentType: 'application/json'
        }
    );
};

/**
 * [커넥션 공유 함수] 
 * 각 컨슈머(Listener)들이 개별 채널을 생성할 수 있도록 현재 커넥션을 반환해.
 */
const getConnection = () => connection;

module.exports = { 
    connectRabbitMQ, 
    publishToQueue, 
    getConnection, 
    QUEUES, 
    ROUTING_KEYS, 
    EXCHANGE 
};