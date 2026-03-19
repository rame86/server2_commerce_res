// src/controllers/resController.js

const prisma = require('../config/prisma');
const resService = require('../services/resService');
const redis = require('../config/redisClient'); 
const { publishToQueue, ROUTING_KEYS } = require('../config/rabbitMQ');

// [1] 예매 생성 (🚀 예약 도메인의 핵심 로직)
exports.createReservation = async (req, res) => {
    // [데이터 바인딩] 클라이언트가 보낸 바디값에서 이벤트ID, 티켓 수량, 회원ID를 추출함
    const { event_id, ticket_count, member_id, selected_seats } = req.body;
    
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
         * 🌟 (수정) 추가로 DB에 저장된 순수 티켓 원가(ticketPrice)와 아티스트 판매 수수료율(salesCommissionRate)도 가져옴.
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
            ticket_code: bookingDetail.ticketCode,
            selected_seats // 🌟 2. [데이터 전달 추가] 서비스 계층으로 좌석 배열 데이터 넘겨주기
        }, member_id);

        /**
         * [비즈니스 로직 3단계: 분산 트랜잭션 시작]
         * 예약 로직은 여기서 멈추고, 실제 돈을 차감하는 작업은 메시지 큐(RabbitMQ)를 통해 결제 서버로 위임함.
         * 이를 통해 예약 서버는 결제가 끝날 때까지 기다리지 않고 다음 사용자의 요청을 바로 받을 수 있음.
         */
        const messagePayload = {
            orderId: bookingDetail.ticketCode,         // 🌟 bookingDetail로 수정 완료
            memberId: Number(member_id),
            amount: Number(bookingDetail.totalPrice),
            artistId: bookingDetail.artistId ? Number(bookingDetail.artistId) : null,
            originalPrice: Number(bookingDetail.ticketPrice), 
            fee: Number(bookingDetail.salesCommissionRate),
            quantity: Number(bookingDetail.quantity),  // 🌟 서비스 규격(quantity)에 맞춤
            type: "PAYMENT",
            eventTitle: bookingDetail.eventTitle,
            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
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

// [3] 환불 요청 접수 (수정: 관리자 승인 절차 추가)
exports.requestRefund = async (req, res) => {
    // [요청 데이터 수집] 티켓 코드와 회원 ID, 그리고 환불 사유(추가)를 받음
    const { ticket_code, member_id, refund_reason } = req.body; 

    try {
        const refundRequestData = await resService.prepareRefundAdminRequest(ticket_code, member_id, refund_reason);

        /**
         * 🌟 Java AdminRefundRequestDTO 규격에 100% 맞춤
         */
        const adminMessagePayload = {
            // 1. 공통 필수 정보
            category: "RES",                            // 예약 서비스 구분값
            type: "REFUND",                             // 고정값
            targetId: refundRequestData.ticketCode,     // 티켓 코드 (targetId)
            title: `[티켓] ${refundRequestData.eventTitle} 환불 요청`, // 화면 노출용 제목
            memberId: Number(member_id),
            totalPrice: Number(refundRequestData.totalPrice),
            status: "PENDING",

            // 2. 상세 데이터 (contentJson에 맵 형태로 담기)
            contentJson: {
                refundId: refundRequestData.refund_id,
                reason: refund_reason || "단순 변심",
                artistId: refundRequestData.artistId,
                quantity: refundRequestData.quantity
            },

            // 3. 부가 정보
            createdAt: new Date().toISOString()
        };

        // [MQ 발행] 관리자 환불 요청 큐로 전송
        await publishToQueue(ROUTING_KEYS.REFUND_REQ_ADMIN, adminMessagePayload);
        
        console.log(`📩 [Admin MQ] DTO 규격으로 환불 요청 전송: ${adminMessagePayload.targetId}`);

        res.status(202).json({ 
            message: "환불 요청이 관리자에게 전달되었습니다.",
            refund_id: refundRequestData.refund_id
        });

    } catch (error) {
        console.error("❌ 환불 요청 접수 실패:", error);
        res.status(error.status || 500).json({ message: error.message });
    }
};

// [4] 내 예매 내역 조회
exports.getMyReservations = async (req, res) => {
    try {
        // [수정] 인증 미들웨어가 없으므로 URL 파라미터(:memberId)에서 직접 가져옴
        const { memberId } = req.params; 


        // memberId가 아예 안 들어왔을 경우만 체크
        if (!memberId) {
            return res.status(400).json({ message: "조회할 회원 ID가 없습니다." });
        }

        const list = await resService.getMyReservations(memberId);

        res.status(200).json({
            message: "성공적으로 조회되었습니다.",
            count: list.length,
            data: list
        });
    } catch (error) {
        console.error("❌ 내 예매 조회 오류:", error);
        res.status(500).json({ message: "내역을 불러오는 중 오류가 발생했습니다." });
    }
};

// [GET] 이벤트 예매자 명단 조회
exports.getEventReservations = async (req, res) => {
    try {
        const {eventId} = req.params;
        const attendes = await resService.getAttendesByEventId(eventId);

        res.status(200).json(attendes);
    } catch (error) {
        console.log("예매자 명단 조회 에러", error);
        res.status(500).json({message:"명단 조회에 실패했습니다."})
    }
}

// [아티스트 대시보드] 최근 5일 예매건수 조회(빈 날짜는 0)
exports.getRecentTicketStats = async (req, res) => {
    try {
        const {memberId} =req.params;

        if(!memberId || isNaN(memberId)) {
            return res.status(400).json({ success: false, message: '유효한 아티스트 ID가 아닙니다.'});
        }
        
        const data = await resService.getTicketStats(memberId);
        return res.status(200).json({
            success: true,
            data
        });
    } catch (error) {
        console.error('[getRecentTicketStats] Error:', error);
        return res.status(500).json({success: false, message: '통계 조회 실패'});
    }
};