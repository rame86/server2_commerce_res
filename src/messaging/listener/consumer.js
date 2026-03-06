// src/messaging/listener/consumer.js
require('dotenv').config();
const amqp = require('amqplib');
const resService = require('../../services/resService');

async function startConsumer() {
    const mqUser = process.env.RABBITMQ_USER || 'guest';
    const mqPass = process.env.RABBITMQ_PASSWORD || 'guest';
    const mqHost = process.env.RABBITMQ_HOST || 'localhost';
    const rabbitUrl = `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        // 💡 큐 이름 통일 및 정리
        const EXCHANGE_NAME = "msa.direct.exchange"; // 우체국 이름
        const PAY_QUEUE = "pay.request.queue";       // 결제 서버가 가져갈 우편함 (결제/환불 모두 여기로!)
        const PAY_ROUTING_KEY = "pay.request";       // 결제 서버로 가는 키
        const RES_QUEUE = 'reservation_queue';       // 예약 큐 (Node.js가 구독)
        const REFUND_REQ_QUEUE = 'refund_request_queue'; // 환불 요청 큐 (Node.js가 구독)

        // 2. 익스체인지 및 큐 생성
        await channel.assertExchange(EXCHANGE_NAME, 'direct', { durable: true });
        await channel.assertQueue(PAY_QUEUE, { durable: true });
        await channel.assertQueue(RES_QUEUE, { durable: true });
        await channel.assertQueue(REFUND_REQ_QUEUE, { durable: true }); 

        // 3. 우체국과 우편함 연결 (Binding)
        await channel.bindQueue(PAY_QUEUE, EXCHANGE_NAME, PAY_ROUTING_KEY);

        console.log(`👷 [Consumer] 대기 중... (구독: ${RES_QUEUE}, ${REFUND_REQ_QUEUE})`);

        // 4. [A] 예약(결제) 요청 큐 모니터링
        channel.consume(RES_QUEUE, async (msg) => {
            if (msg !== null) {
                const data = JSON.parse(msg.content.toString());
                console.log("📦 [수신] 새로운 예약 건 도착:", data.ticket_code);

                try {
                    // 5. DB 트랜잭션 실행 (예약 생성 + 재고 차감)
                    await resService.makeReservation(data, data.member_id);
                    console.log(`✅ [성공] DB 저장 완료: ${data.ticket_code}`);
                    
                    // 6. Spring Payment DTO 형식에 맞춰 데이터 매핑 (PAYMENT 타입)
                    const paymentData = {
                        orderId: data.ticket_code, 
                        memberId: data.member_id, 
                        amount: data.total_price, 
                        type: "PAYMENT", // 결제 요청
                        replyRoutingKey: "res.status.update" 
                    };

                    // 7. 결제 서버로 메시지 전달
                    channel.publish(
                        EXCHANGE_NAME, 
                        PAY_ROUTING_KEY, 
                        Buffer.from(JSON.stringify(paymentData)),
                        { persistent: true } 
                    );

                    console.log(`💸 [결제 요청] 회신 주소(${paymentData.replyRoutingKey}) 포함해서 전송 완료`);
                    channel.ack(msg);
                } catch (dbErr) {
                    console.error("❌ [실패] 예약 처리 중 에러:", dbErr.message);
                    channel.nack(msg, false, false); // 에러 시 버림 (실무에선 DLQ 활용)
                }
            }
        });

        // 8. [B] 환불 요청 큐 모니터링 (새로 수정한 부분)
        // ❌ PAY_QUEUE를 구독하면 안 됨! 환불 요청 전용 큐(REFUND_REQ_QUEUE)를 구독해야 해.
        channel.consume(REFUND_REQ_QUEUE, async (msg) => {
            if (msg !== null) {
                const data = JSON.parse(msg.content.toString()); 
                console.log("♻️ [수신] 환불 요청 도착:", data.ticket_code);

                try {
                    // 💡 환불도 결제 서버(Spring)로 요청해야 해! 
                    // DB 원복은 나중에 Spring이 'REFUNDED' 상태를 돌려주면 statusUpdateConsumer에서 처리함.
                    const refundData = {
                        orderId: data.ticket_code,
                        memberId: data.member_id,
                        amount: data.cancel_amount, // 취소 금액 (필요시)
                        type: "REFUND", // 환불 요청 타입!
                        replyRoutingKey: "res.status.update" 
                    };

                    // 결제 서버(Spring)의 PAY_QUEUE로 메시지 쏘기
                    channel.publish(
                        EXCHANGE_NAME, 
                        PAY_ROUTING_KEY, 
                        Buffer.from(JSON.stringify(refundData)),
                        { persistent: true } 
                    );

                    console.log(`🔙 [환불 요청] 결제 서버로 전송 완료 (주문번호: ${refundData.orderId})`);
                    channel.ack(msg);
                } catch (refundErr) {
                    console.error("❌ [환불 요청 실패]:", refundErr.message);
                    channel.nack(msg, false, false);
                }
            }
        });

    } catch (err) {
        console.error("RabbitMQ 연결 실패:", err);
    }
}

module.exports = startConsumer;