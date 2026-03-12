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
 * 서버와 커넥션을 맺고 메시지 발행을 위한 기본 채널을 초기화
 */
const connectRabbitMQ = async () => {
    try {
        const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

        // 1. 물리적 연결(Connection) 생성
        connection = await amqp.connect(rabbitUrl);
        
        /**
         * 2. [핵심] Confirm 채널 생성
         * 일반 채널과 달리 서버의 수신 확인(Ack)을 받을 수 있어 메시지 유실을 방지함.
         */
        channel = await connection.createConfirmChannel(); 
        
        // 3. 메시지 분류기(Exchange) 선언
        await channel.assertExchange(EXCHANGE, 'direct', { durable: true });

        /**
         * 4. [안정성] 선제적 큐 생성 및 바인딩
         * 상대방(관리자 서버 등)이 꺼져 있어도 메시지가 증발하지 않도록 미리 바구니를 만들어 둠.
         */
        await channel.assertQueue('admin.event.queue', { durable: true });
        await channel.bindQueue('admin.event.queue', EXCHANGE, ROUTING_KEYS.EVENT_REQ_ADMIN);

        console.log("✅ RabbitMQ Confirm 채널 및 관리자 큐 바인딩 성공");
    } catch (error) {
        console.error("❌ RabbitMQ 연결 실패:", error);
    }
};

/**
 * [공통 메시지 발행] 
 * 🌟 waitForConfirms를 사용하여 메시지가 큐에 들어갔는지 확실히 보장함
 */
const publishToQueue = async (routingKey, message) => {
    if (!channel) {
        console.error("❌ RabbitMQ 채널이 준비되지 않았어.");
        return;
    }
    
    // 1. 메시지를 바구니에 넣기 (서버가 꺼져도 유지되도록 설정)
    const isSent = channel.publish(
        EXCHANGE, 
        routingKey, 
        Buffer.from(JSON.stringify(message)), 
        { 
            persistent: true, // 메시지를 디스크에 저장해서 안전하게 보관
            contentType: 'application/json' // 데이터가 JSON 형식임을 명시
        }
    );
    // 버퍼 문제로 전송 실패 시 에러 처리
    if (!isSent) {
        throw new Error("🚀 RabbitMQ 내부 버퍼가 가득 차서 전송에 실패했습니다.");
    }

    /**
     * 2. 🌟 [핵심] RabbitMQ 서버가 메시지를 안전하게 받았다고 응답할 때까지 대기
     * 이 작업이 있어야 '비동기'로 던지고 끝나는 게 아니라, 안전하게 도착했는지 확인까지 끝내게 됨
     */
    try {
        await channel.waitForConfirms();
        // console.log("✔️ 메시지가 큐에 안전하게 저장되었습니다.");
    } catch (err) {
        console.error("❌ 메시지 전송 확인 중 오류 발생:", err);
        throw err;
    }
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