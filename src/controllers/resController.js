// src/controllers/resController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const resService = require('../services/resService');
const redis = require('../config/redisClient'); 
const { publishToQueue, ROUTING_KEYS } = require('../config/rabbitMQ');

// [1] 예매 생성 (🚀 예약 도메인의 핵심 로직)
exports.createReservation = async (req, res) => {
    // [데이터 바인딩] 클라이언트가 보낸 바디값에서 이벤트ID, 티켓 수량, 회원ID를 추출함
    const { event_id, ticket_count, member_id } = req.body;
    
    // [타입 보정] 문자열로 들어올 수 있는 티켓 수량을 연산을 위해 정수형(Int)으로 변환함
    const count = parseInt(ticket_count, 10);
    
    // [인증 확인] 헤더의 Authorization 필드에서 JWT 토큰 문자열만 분리하여 추출함
    const clientToken = req.headers.authorization?.split(' ')[1];

    // [방어 코드] 토큰이 아예 없는 비정상적인 접근일 경우 401 인증 에러로 즉시 차단함
    if (!clientToken) return res.status(401).json({ message: "토큰이 없습니다." });

    try {
        /**
         * [비즈니스 로직 1단계: 선검증 및 재고 확보]
         * 서비스 계층을 통해 Redis에서 실시간 재고를 차감하고, 유저의 잔액이 충분한지 등을 종합적으로 검증함.
         * 이 단계가 성공해야만 '티켓 번호'와 '총 결제 금액'이 생성됨.
         */
        const bookingDetail = await resService.validateAndPrepare(event_id, count, member_id);
        
        /**
         * [비즈니스 로직 2단계: 예약 가저장]
         * 아직 결제가 완료된 것은 아니지만, 선점한 자리에 대해 DB에 'PENDING(대기)' 상태로 기록을 남김.
         * 이는 추후 결제 서버로부터 응답을 받았을 때 상태를 업데이트하기 위한 기초 데이터가 됨.
         */
        await resService.makeReservation({
            event_id,
            ticket_count: count,
            total_price: bookingDetail.totalPrice,
            booking_fee: bookingDetail.bookingFee,
            ticket_code: bookingDetail.ticketCode
        }, member_id);

        /**
         * [비즈니스 로직 3단계: 분산 트랜잭션 시작]
         * 예약 로직은 여기서 멈추고, 실제 돈을 차감하는 작업은 메시지 큐(RabbitMQ)를 통해 결제 서버로 위임함.
         * 이를 통해 예약 서버는 결제가 끝날 때까지 기다리지 않고 다음 사용자의 요청을 바로 받을 수 있음.
         */
        const messagePayload = {
            orderId: bookingDetail.ticketCode, // 추적을 위한 고유 주문 번호
            memberId: Number(member_id),       // 회원 식별자
            amount: Number(bookingDetail.totalPrice), // 실제 결제 요청 금액
            type: "PAYMENT",                   // 결제 타입 명시
            eventTitle: bookingDetail.eventTitle, // 사용자 알림용 공연 제목
            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE // 결제 완료 후 결과를 돌려받을 통로 지정
        };
        
        // [MQ 발행] 결제 서비스가 구독 중인 큐(pay.request.queue)로 데이터를 쏘아 보냄
        await publishToQueue(ROUTING_KEYS.PAY_REQUEST, messagePayload);
        console.log(`🚀 [MQ 전송] 결제 요청 발송 완료: ${bookingDetail.ticketCode}`);

        /**
         * [최종 응답: 202 Accepted]
         * '200 OK'가 아닌 '202'를 반환하는 것은 "요청은 접수되었고 처리는 비동기로 진행 중"임을 뜻하는 
         * RESTful API의 표준 관례임. 사용자는 티켓 코드를 받고 결과를 기다리는 상태가 됨.
         */
        res.status(202).json({ 
            message: "예약 요청이 성공적으로 접수되었습니다.",
            ticket_id: bookingDetail.ticketCode,
            total_price: bookingDetail.totalPrice
        });

    } catch (error) {
        // [에러 핸들링] 서비스 계층에서 던진 400(재고부족), 401(인증불가) 등의 상태 코드를 그대로 전달함
        console.error("❌ 예약 처리 중 오류:", error);
        res.status(error.status || 500).json({ message: error.message || "서버 오류" });
    }
};

// [2] 특정 유저의 예약 상태 확인
exports.getReservationStatus = async (req, res) => {
    try {
        // [파라미터 추출] 조회하고자 하는 유저의 ID를 URL 경로에서 가져옴
        const { userId } = req.params;
        
        // [구현 예정] 비동기 처리 특성상 클라이언트가 본인의 예약이 성공했는지 폴링(Polling)할 때 사용될 엔드포인트임
        res.json({ message: "조회 기능 준비 중", userId });
    } catch (error) {
        console.error("❌ 예약 상태 조회 오류:", error);
        res.status(500).json({ message: "상태 조회 중 오류 발생" });
    }
};

// [3] 환불 요청 접수
exports.requestRefund = async (req, res) => {
    // [요청 데이터 수집] 어떤 티켓을 어떤 유저가 환불하려 하는지 데이터를 받음
    const { ticket_code, member_id } = req.body; 

    try {
        /**
         * [비즈니스 로직 1단계: 환불 자격 검증]
         * 본인의 티켓이 맞는지, 이미 사용된 티켓은 아닌지 등을 DB에서 확인하고 
         * 환불해야 할 금액(cancel_amount) 데이터를 계산해 옴.
         */
        const refundPayload = await resService.processRefund(ticket_code, member_id);

        /**
         * [비즈니스 로직 2단계: 결제 취소 요청]
         * 실제 돈을 환불해 주는 것 역시 비동기로 처리함. 
         * 결제 서버에 "이 주문번호 환불해 줘"라고 RabbitMQ 메시지를 보냄.
         */
        const messagePayload = {
            orderId: refundPayload.ticket_code,
            memberId: Number(refundPayload.member_id),
            amount: Number(refundPayload.cancel_amount),
            type: "REFUND", // 타입만 REFUND로 바꿔서 결제 서버에 전달
            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
        };

        // [MQ 발행] 환불 처리 과정 시작
        await publishToQueue(ROUTING_KEYS.PAY_REQUEST, messagePayload);
        console.log(`🚀 [MQ 전송] 환불 요청 발송 완료: ${refundPayload.ticket_code}`);

        // [응답] 사용자에게는 요청이 정상 접수되었음을 알림
        res.status(200).json({ message: "환불 요청이 접수되었습니다." });
    } catch (error) {
        // [에러 처리] 잘못된 티켓 코드 등 예외 상황에 대해 적절한 에러 코드를 전송함
        console.error("❌ 환불 처리 오류:", error);
        res.status(error.status || 500).json({ message: error.message });
    }
};