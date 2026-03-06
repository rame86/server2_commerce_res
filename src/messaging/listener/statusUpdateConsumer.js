//src/messaging/listener/statusUpdateConsumer.js

const amqp = require('amqplib');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../../config/redisClient');
const { QUEUES, EXCHANGE, ROUTING_KEYS } = require('../../config/rabbitMQ');

/**
 * [결제 상태 업데이트 소비자]
 * 결제 시스템(Spring)으로부터 결제 처리 결과(성공/실패/환불)를 비동기로 수신하여
 * 예약 서버의 DB 상태를 최종 변경하고, 필요 시 Redis 및 DB 재고를 복구함.
 */
async function startStatusUpdateConsumer() {
    // [커넥션 설정] RabbitMQ 접속을 위한 URL 정보를 환경 변수에서 조합함
    const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

    try {
        // [연결 수립] RabbitMQ 서버와 연결을 맺고 통신을 위한 채널을 오픈함
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        // [큐 및 바인딩 선언] 상태 업데이트 전용 큐를 생성하고, 익스체인지와 라우팅 키를 연결하여 메시지 경로를 확정함
        await channel.assertQueue(QUEUES.STATUS_UPDATE, { durable: true });
        await channel.bindQueue(QUEUES.STATUS_UPDATE, EXCHANGE, ROUTING_KEYS.STATUS_UPDATE);

        console.log(`📩 [Status Consumer] 결과 수신 대기 중: ${QUEUES.STATUS_UPDATE}`);

        /**
         * [메시지 소비 루프]
         * 결제 서버에서 보낸 결과 메시지가 도착할 때마다 아래 콜백 함수가 실행됨
         */
        channel.consume(QUEUES.STATUS_UPDATE, async (msg) => {
            // [방어 코드] 빈 메시지가 수신된 경우 무시함
            if (!msg) return;

            // [메시지 파싱] 결제 결과 데이터(주문번호, 상태, 타입 등)를 JSON 객체로 변환함
            const response = JSON.parse(msg.content.toString());
            const { orderId, status, type, message } = response;

            // [데이터 정규화] 상태값 비교의 정확성을 위해 수신된 상태 문자열을 모두 대문자로 변환함
            const normalizedStatus = status ? status.toUpperCase() : '';

            try {
                /**
                 * 1. [공통 데이터 조회]
                 * 메시지에 담긴 주문번호(ticket_code)를 기준으로 현재 우리 DB에 기록된 예약 정보를 찾음.
                 * 어떤 작업을 하든 이 데이터가 기준점이 됨.
                 */
                const res = await prisma.reservations.findUnique({ where: { ticket_code: orderId } });
                
                // [데이터 검증] 만약 우리 쪽 DB에 해당 주문 번호가 없다면, 잘못된 메시지로 판단하고 처리 종료(Ack)함
                if (!res) {
                    console.warn(`⚠️ [경고] 존재하지 않는 티켓 메시지 수신: ${orderId}`);
                    return channel.ack(msg);
                }

                console.log(`📩 [수신] 주문:${orderId} | 상태:${normalizedStatus} | 타입:${type}`);

                /**
                 * 2. [환불 성공 처리 로직]
                 * 상태값이 'REFUNDED'이거나 요청 타입 자체가 'REFUND'인 경우 실행됨.
                 */
                if (normalizedStatus === 'REFUNDED' || type === 'REFUND') {
                    // [중복 처리 방지] 이미 DB 상태가 환불 완료라면 재고를 중복으로 늘리지 않도록 체크함
                    if (res.status !== 'REFUNDED') {
                        /**
                         * [DB 원자적 업데이트]
                         * 예약 상태를 'REFUNDED'로 바꾸고, 공연의 잔여 좌석을 즉시 늘려주는 작업을 트랜잭션으로 묶음
                         */
                        await prisma.$transaction(async (tx) => {
                            // 예약 정보 업데이트
                            await tx.reservations.update({
                                where: { ticket_code: orderId },
                                data: { status: 'REFUNDED' }
                            });
                            // 공연 재고 수량 복구
                            await tx.events.update({
                                where: { event_id: res.event_id },
                                data: { available_seats: { increment: res.ticket_count } }
                            });
                        });

                        /**
                         * [Redis 실시간 재고 복구]
                         * 다음 구매자가 바로 이 자리를 살 수 있도록 Redis의 메모리 재고 숫자를 즉시 증가시킴
                         */
                        const stockKey = `event:stock:${res.event_id}`;
                        const newStock = await redis.incrBy(stockKey, res.ticket_count);
                        console.log(`♻️ [환불 완료] 주문 ${orderId} -> 재고 ${res.ticket_count}개 복구 (현재고: ${newStock})`);
                    }
                }
                
                /**
                 * 3. [결제 실패 처리 로직 (Rollback)]
                 * 사용자의 잔액 부족 등으로 결제가 최종 실패했을 때 수행됨.
                 */
                else if (['FAIL', 'FAILED'].includes(normalizedStatus)) {
                    // [상태 체크] 이미 실패 처리가 된 건인지 확인하여 무의미한 재고 복구 중복 방지
                    if (res.status !== 'FAILED') {
                        /**
                         * [DB 보상 트랜잭션]
                         * 상태를 'FAILED'로 기록하고 점유했던 좌석을 다시 시장에 내놓음(increment)
                         */
                        await prisma.$transaction(async (tx) => {
                            await tx.reservations.update({ where: { ticket_code: orderId }, data: { status: 'FAILED' } });
                            await tx.events.update({ where: { event_id: res.event_id }, data: { available_seats: { increment: res.ticket_count } } });
                        });
                        
                        // [Redis 복구] 실시간 선착순 엔진인 Redis 재고를 원래대로 돌려놓음
                        await redis.incrBy(`event:stock:${res.event_id}`, res.ticket_count);
                        console.log(`⏪ [롤백 완료] 결제 실패로 인한 주문 ${orderId} 재고 복구 성공`);
                    }
                }

                /**
                 * 4. [결제 최종 성공 처리 로직]
                 * 결제가 완벽히 처리되어 'COMPLETE' 또는 'SUCCESS' 결과가 온 경우임.
                 */
                else if (['COMPLETE', 'SUCCESS'].includes(normalizedStatus)) {
                    // [최종 확정] PENDING 상태였던 예약을 'CONFIRMED'로 변경하여 유효한 티켓으로 만듦
                    if (res.status !== 'CONFIRMED') {
                        await prisma.reservations.update({
                            where: { ticket_code: orderId },
                            data: { status: 'CONFIRMED' }
                        });
                        console.log(`✅ [결제 완료] 주문 ${orderId} -> CONFIRMED 상태 변경`);
                    }
                }

                // [수신 확인 응답] 메시지 처리가 정상적으로 끝났음을 RabbitMQ에 알리고 큐에서 제거함
                channel.ack(msg);

            } catch (error) {
                // [예외 처리] 내부 로직 수행 중 오류 발생 시 에러 로그를 남기고 메시지 재처리를 막음(requeue: false)
                console.error("❌ Status Consumer 내부 에러:", error.message);
                channel.nack(msg, false, false);
            }
        });
    } catch (error) {
        console.error("❌ StatusUpdateConsumer 연결 실패:", error.message);
    }
}

module.exports = startStatusUpdateConsumer;