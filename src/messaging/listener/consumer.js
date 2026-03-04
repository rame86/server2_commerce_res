// //src/messaging/listener/consumer.js
require('dotenv').config();
const amqp = require('amqplib');
const resService = require('../../services/resService');

async function startConsumer() {
    // 1. 환경 변수에서 접속 정보 로드 (기본값 guest)
    const mqUser = process.env.RABBITMQ_USER || 'guest';
    const mqPass = process.env.RABBITMQ_PASSWORD || 'guest';
    const mqHost = process.env.RABBITMQ_HOST || 'localhost';
    const rabbitUrl = `amqp://${mqUser}:${mqPass}@${mqHost}:5672`;

    try {
        const connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();

        // 💡 [핵심] Spring 설정(RabbitMQConfig.java)과 완벽히 일치해야 함
        const EXCHANGE_NAME = "msa.direct.exchange"; // 우체국 이름
        const PAY_QUEUE = "pay.request.queue";       // 결제 서버가 가져갈 우편함
        const PAY_ROUTING_KEY = "pay.request";       // 결제 요청 주소(키)
        const RES_QUEUE = 'reservation_queue';       // 현재 컨슈머가 구독할 예약 큐
        const REFUND_QUEUE = 'refund_request_queue'; // [추가] 환불 요청용 큐

        // 2. 익스체인지 및 큐 생성 (durable: true는 서버 꺼져도 데이터 유지)
        await channel.assertExchange(EXCHANGE_NAME, 'direct', { durable: true });
        await channel.assertQueue(PAY_QUEUE, { durable: true });
        await channel.assertQueue(RES_QUEUE, { durable: true });
        await channel.assertQueue(REFUND_QUEUE, { durable: true }); 

        // 3. 우체국과 우편함 연결 (Binding)
        // msa.direct.exchange에 pay.request 키가 붙은 메시지는 pay.request.queue로 간다!
        // 바인딩 (결제 서버로 나가는 통로 확보)
        await channel.bindQueue(PAY_QUEUE, EXCHANGE_NAME, PAY_ROUTING_KEY);

        console.log(`👷 [Consumer] 대기 중... (구독: ${PAY_QUEUE})`);

        // 4. 예약 큐 모니터링 시작
        channel.consume(RES_QUEUE, async (msg) => {
            if (msg !== null) {
                // Buffer 데이터를 JSON 객체로 파싱
                const data = JSON.parse(msg.content.toString());
                console.log("📦 [수신] 새로운 예약 건 도착:", data.ticket_code);

                try {
                    // 5. DB 트랜잭션 실행 (예약 생성 + 재고 차감)
                    await resService.makeReservation(data, data.member_id);
                    console.log(`✅ [성공] DB 저장 완료: ${data.ticket_code}`);
                    
                    // 6. Spring Payment DTO 형식에 맞춰 데이터 매핑
                    // 주의: Java 쪽 DTO 필드명과 일치하는지 꼭 확인할 것 (member_id vs memberId)
                    const paymentData = {
                        orderId: data.ticket_code,         // reference_id 대신 orderId 사용
                        memberId: data.member_id,          // member_id 대신 memberId 사용
                        amount: data.total_price,       // 결제 금액
                        type: "PAYMENT",             // 결제 요청 타입 명시
                        replyRoutingKey: "res.status.update" // ✅ 결제 서버가 나중에 나한테 답장 줄 주소
                    };

                    // 7. [중요] 결제 서버로 메시지 전달 (Exchange와 Routing Key 사용)
                    // Spring의 Jackson2JsonMessageConverter가 JSON을 객체로 자동 변환해줌
                    channel.publish(
                        EXCHANGE_NAME, 
                        PAY_ROUTING_KEY, 
                        Buffer.from(JSON.stringify(paymentData)),
                        { persistent: true } 
                    );

                    console.log(`💸 [결제 요청] 회신 주소(${paymentData.replyRoutingKey}) 포함해서 전송 완료`);
                    // 8. 메시지 처리 완료 알림 (큐에서 삭제)
                    channel.ack(msg);
                } catch (dbErr) {
                    // 에러 발생 시 처리 (실무에선 보통 nack를 통해 재시도하거나 에러 큐로 보냄)
                    console.error("❌ [실패] 처리 중 에러:", dbErr.message);
                    // 실패 시 ack를 하지 않거나 nack 처리로 큐에 남길 수 있음
                }
            }
        });

        // --- [B] 환불 요청 처리 (새로 추가) ---
        // 사용자가 환불을 눌렀을 때 실행되는 큐
        channel.consume(PAY_QUEUE, async (msg) => {
            if (msg !== null) {
                const data = JSON.parse(msg.content.toString()); // { ticket_code, member_id ... }
                console.log("♻️ [환불수신] 환불 요청 도착:", data.ticket_code);

                try {
                    // 서비스 레이어의 환불 로직 실행 (DB 원복 + Redis 원복)
                    // 여기서 resService.processRefund 내부에서 최종적으로 Spring에 메시지를 쏨
                    await resService.processRefund(data); 
                    
                    channel.ack(msg);
                } catch (refundErr) {
                    console.error("❌ [환불실패]:", refundErr.message);
                    channel.nack(msg, false, false);
                }
            }
        });

    } catch (err) {
        console.error("RabbitMQ 연결 실패:", err);
    }
}


// 컨슈머 실행
module.exports = startConsumer;