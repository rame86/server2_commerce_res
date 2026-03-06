const amqp = require('amqplib');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const redis = require('../../config/redisClient');
const { QUEUES, EXCHANGE, ROUTING_KEYS } = require('../../config/rabbitMQ');

/**
 * 결제 서버(Spring)로부터 받은 최종 처리 결과(성공/실패/환불)를 
 * 우리 DB 및 Redis 재고에 동기화하는 소비자 함수야.
 */
async function startStatusUpdateConsumer() {
    const rabbitUrl = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        await channel.assertQueue(QUEUES.STATUS_UPDATE, { durable: true });
        await channel.bindQueue(QUEUES.STATUS_UPDATE, EXCHANGE, ROUTING_KEYS.STATUS_UPDATE);

        console.log(`📩 [Status Consumer] 결과 수신 대기 중: ${QUEUES.STATUS_UPDATE}`);

        channel.consume(QUEUES.STATUS_UPDATE, async (msg) => {
            if (!msg) return;

            const response = JSON.parse(msg.content.toString());
            const { orderId, status, type, message } = response;
            const normalizedStatus = status ? status.toUpperCase() : '';

            try {
                // 1. [공통] 데이터 조회 (어떤 작업이든 일단 티켓 정보가 필요해)
                const res = await prisma.reservations.findUnique({ where: { ticket_code: orderId } });
                
                if (!res) {
                    console.warn(`⚠️ [경고] 존재하지 않는 티켓 메시지 수신: ${orderId}`);
                    return channel.ack(msg);
                }

                console.log(`📩 [수신] 주문:${orderId} | 상태:${normalizedStatus} | 타입:${type}`);

                // 2. 환불 처리 (REFUNDED) - 상태가 REFUNDED이거나 타입이 REFUND일 때
                if (normalizedStatus === 'REFUNDED' || type === 'REFUND') {
                    if (res.status !== 'REFUNDED') {
                        await prisma.$transaction(async (tx) => {
                            // [DB] 상태 변경
                            await tx.reservations.update({
                                where: { ticket_code: orderId },
                                data: { status: 'REFUNDED' }
                            });
                            // [DB] 재고 복구
                            await tx.events.update({
                                where: { event_id: res.event_id },
                                data: { available_seats: { increment: res.ticket_count } }
                            });
                        });

                        // [Redis] 실시간 재고 복구
                        const stockKey = `event:stock:${res.event_id}`;
                        const newStock = await redis.incrBy(stockKey, res.ticket_count);
                        console.log(`♻️ [환불 완료] 주문 ${orderId} -> 재고 ${res.ticket_count}개 복구 (현재고: ${newStock})`);
                    }
                }
                
                // 3. 결제 실패 처리 (FAIL / FAILED)
                else if (['FAIL', 'FAILED'].includes(normalizedStatus)) {
                    if (res.status !== 'FAILED') {
                        await prisma.$transaction(async (tx) => {
                            await tx.reservations.update({ where: { ticket_code: orderId }, data: { status: 'FAILED' } });
                            await tx.events.update({ where: { event_id: res.event_id }, data: { available_seats: { increment: res.ticket_count } } });
                        });
                        await redis.incrBy(`event:stock:${res.event_id}`, res.ticket_count);
                        console.log(`⏪ [롤백 완료] 결제 실패로 인한 주문 ${orderId} 재고 복구 성공`);
                    }
                }

                // 4. 결제 성공 처리 (COMPLETE / SUCCESS)
                else if (['COMPLETE', 'SUCCESS'].includes(normalizedStatus)) {
                    if (res.status !== 'CONFIRMED') {
                        await prisma.reservations.update({
                            where: { ticket_code: orderId },
                            data: { status: 'CONFIRMED' }
                        });
                        console.log(`✅ [결제 완료] 주문 ${orderId} -> CONFIRMED 상태 변경`);
                    }
                }

                channel.ack(msg);

            } catch (error) {
                console.error("❌ Status Consumer 내부 에러:", error.message);
                channel.nack(msg, false, false);
            }
        });
    } catch (error) {
        console.error("❌ StatusUpdateConsumer 연결 실패:", error.message);
    }
}

module.exports = startStatusUpdateConsumer;