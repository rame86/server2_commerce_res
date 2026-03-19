// src/messaging/listener/eventResponseConsumer.js

// 관리자 응답을 실제로 처리할 비즈니스 로직(Service)과 RabbitMQ 공통 설정을 가져옴
const eventService = require('../../services/eventService'); 
const { EXCHANGE, QUEUES, ROUTING_KEYS, getConnection } = require('../../config/rabbitMQ');

/**
 * [관리자 응답 컨슈머 시작]
 * 관리자 서비스(Admin)에서 결정된 승인/반려 결과를 실시간으로 수신하여 후속 조치를 취함
 */
async function startEventResponseConsumer() {
    try {
        // 1. [커넥션 재사용] 중앙 설정(rabbitMQ.js)에 열려있는 물리적 연결을 공유함
        const connection = getConnection();
        if (!connection) throw new Error("RabbitMQ 연결이 안 되어 있어.");

        // 2. [채널 생성] 관리자 응답 처리만을 위한 독립적인 논리 통로(Channel)를 개설
        const channel = await connection.createChannel();

        // 3. [큐 확인] 관리자가 보낸 답장을 담아둘 우체통(EVENT_RES_CORE)이 있는지 확인
        // durable: true 설정으로 메시지가 유실되지 않도록 안전하게 보관함
        await channel.assertQueue(QUEUES.EVENT_RES_CORE, { durable: true });

         /* 4. [바인딩 설정] 
         * 우체국(Exchange)과 큐를 'event.res.core'라는 주소표(Routing Key)로 연결
         * 관리자가 이 주소로 답장을 보내면 우리 우체통으로 쏙 들어오게 됨*/
        await channel.bindQueue(QUEUES.EVENT_RES_CORE, EXCHANGE, ROUTING_KEYS.EVENT_RES_CORE);

        // 대기 시작 로그 출력
        console.log(`📡 [Admin Response Consumer] 대기 중: ${QUEUES.EVENT_RES_CORE}`);

        /**
         * [메시지 소비 루프]
         * 관리자가 보낸 승인/반려 메시지가 도착할 때마다 아래 비동기 함수가 실행됨
         */
        channel.consume(QUEUES.EVENT_RES_CORE, async (msg) => {
            // 메시지가 유효하지 않으면 즉시 리턴
            if (!msg) return;

            try {
                // 5. [데이터 역직렬화] Buffer 형태의 메시지 내용을 JSON 객체로 파싱
                const response = JSON.parse(msg.content.toString());
                // 메시지 안에 담긴 이벤트 ID(또는 승인 ID)를 추출
                const targetId = response.eventId || response.approvalId;
                console.log(`📩 [수신] 관리자 응답 도착: ID ${targetId}, 상태: ${response.status}`);
                
                // 6. [서비스 레이어 위임] 파싱된 데이터를 가지고 실제 DB 업데이트(이벤트 생성/반려 처리) 수행
                // eventService.processAdminResponse가 실제 비즈니스 로직의 핵심임
                await eventService.processAdminResponse(response);

                // 7. [수신 확인] 모든 처리가 정상적으로 끝났으므로 RabbitMQ에서 해당 메시지 삭제(Ack)
                channel.ack(msg);
            } catch (err) {
                // 8. [예외 처리] 처리 중 에러 발생 시 로그를 남기고 메시지 삭제 처리(Nack)
                // (requeue: false 설정을 통해 무한 재처리에 따른 시스템 부하 방지)
                console.error("❌ 처리 오류:", err.message);
                channel.nack(msg, false, false);
            }
        });
    } catch (err) {
        // 커넥션 오류 등 초기화 단계 실패 시 에러 출력
        console.error("❌ EventResponseConsumer 에러:", err.message);
    }
}

module.exports = startEventResponseConsumer;