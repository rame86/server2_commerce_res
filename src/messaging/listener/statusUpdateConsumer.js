// src/messaging/listener/statusUpdateConsumer.js
// 데이터베이스(Prisma), 캐시(Redis), 그리고 중앙 RabbitMQ 설정을 가져옴
const prisma = require('../../config/prisma');
const redis = require('../../config/redisClient');
const { QUEUES, EXCHANGE, ROUTING_KEYS, getConnection } = require('../../config/rabbitMQ');

/**
 * [결제 상태 업데이트 컨슈머 시작]
 * 결제 서비스(Spring)로부터 받은 결제 결과를 우리 시스템(DB/Redis)에 최종 반영함
 */
async function startStatusUpdateConsumer() {
    try {
        // 1. [커넥션 재사용] rabbitMQ.js에 열려있는 물리적 연결을 공유함
        const connection = getConnection();
        if (!connection) throw new Error("RabbitMQ 연결이 안 되어 있어.");

        // 2. [채널 생성] 상태 업데이트 처리를 위한 전용 논리 통로(Channel) 개설
        const channel = await connection.createChannel();

        // 3. [인프라 선언 및 바인딩] 상태 업데이트 큐를 생성하고 익스체인지-라우팅 키와 연결함
        await channel.assertQueue(QUEUES.STATUS_UPDATE, { durable: true });
        await channel.bindQueue(QUEUES.STATUS_UPDATE, EXCHANGE, ROUTING_KEYS.STATUS_UPDATE);

        console.log(`📩 [Status Consumer] 결과 수신 대기 중: ${QUEUES.STATUS_UPDATE}`);

        /**
         * [메시지 소비 루프]
         * 결제 서버에서 결과 메시지가 도착할 때마다 실행됨
         */
        channel.consume(QUEUES.STATUS_UPDATE, async (msg) => {
            if (!msg) return;

            // 4. [데이터 파싱 및 정규화] 메시지 내용을 읽고 상태값을 대문자로 통일함
            const response = JSON.parse(msg.content.toString());
            const { orderId, status, type } = response;
            const normalizedStatus = status ? status.toUpperCase() : '';

            try {
                // 5. [데이터 조회] 주문번호(ticket_code)로 현재 우리 DB의 예약 정보를 찾음
                const res = await prisma.reservations.findUnique({ where: { ticket_code: orderId } });
                
                // 해당 주문이 우리 DB에 없으면 잘못된 요청이므로 로그만 남기고 메시지 삭제
                if (!res) {
                    console.warn(`⚠️ [경고] 존재하지 않는 티켓 메시지 수신: ${orderId}`);
                    return channel.ack(msg);
                }

                console.log(`📩 [수신] 주문:${orderId} | 상태:${normalizedStatus} | 타입:${type}`);

                /**
                 * 6. [상태별 비즈니스 로직 처리]
                 * 환불(REFUNDED), 실패(FAILED), 성공(COMPLETE) 케이스별로 대응함
                 */

                // Case A: 환불 완료 처리
                if (normalizedStatus === 'REFUNDED') {
                    if (res.status !== 'REFUNDED') {
                        // DB 트랜잭션: 예약 상태를 환불로 바꾸고 DB 재고를 즉시 복구함
                        await prisma.$transaction(async (tx) => {
                            await tx.reservations.update({ where: { ticket_code: orderId }, data: { status: 'REFUNDED' } });
                            await tx.events.update({ where: { event_id: res.event_id }, data: { available_seats: { increment: res.ticket_count } } });
                        });
                        // Redis 재고 복구: 실시간 선착순 엔진 수량 원복
                        await redis.incrBy(`event:stock:${res.event_id}`, res.ticket_count);
                        console.log(`♻️ [환불 완료] 주문 ${orderId} 복구`);
                    }
                } 
                
                // Case B: 결제 실패 처리 (롤백)
                else if (['FAIL', 'FAILED'].includes(normalizedStatus)) {
                    if (res.status !== 'FAILED') {
                        // DB 트랜잭션: 예약 상태를 실패로 기록하고 DB 재고를 다시 시장에 내놓음
                        await prisma.$transaction(async (tx) => {
                            await tx.reservations.update({ where: { ticket_code: orderId }, data: { status: 'FAILED' } });
                            await tx.events.update({ where: { event_id: res.event_id }, data: { available_seats: { increment: res.ticket_count } } });
                        });
                        // Redis 재고 복구: 결제가 안 됐으므로 점유했던 수량을 다시 채워넣음
                        await redis.incrBy(`event:stock:${res.event_id}`, res.ticket_count);
                        console.log(`⏪ [롤백 완료] 결제 실패 복구 성공`);
                    }
                } 
                
                // Case C: 결제 최종 성공 처리 (확정)
                else if (['COMPLETE', 'SUCCESS'].includes(normalizedStatus)) {
                    if (res.status !== 'CONFIRMED') {
                        // 예약 상태를 'CONFIRMED'로 변경하여 유효한 티켓으로 확정함
                        await prisma.reservations.update({ where: { ticket_code: orderId }, data: { status: 'CONFIRMED' } });
                        console.log(`✅ [결제 완료] 주문 ${orderId} CONFIRMED`);
                    }
                }

                // 7. [수신 확인] 모든 작업이 안전하게 끝났으므로 큐에서 메시지 제거
                channel.ack(msg);
            } catch (error) {
                // 8. [예외 처리] 내부 로직 오류 시 로그를 남기고 메시지는 삭제 처리 (Nack)
                console.error("❌ Status Consumer 내부 에러:", error.message);
                channel.nack(msg, false, false);
            }
        });
    } catch (error) {
        // 커넥션이나 채널 생성 실패 시 에러 로깅
        console.error("❌ StatusUpdateConsumer 에러:", error.message);
    }
}

module.exports = startStatusUpdateConsumer;