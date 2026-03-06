// src/controllers/resController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const resService = require('../services/resService');
const redis = require('../config/redisClient'); 
const { publishToQueue, ROUTING_KEYS } = require('../config/rabbitMQ');

// [1] 예매 생성 (🚀 예약 도메인의 핵심 로직)
exports.createReservation = async (req, res) => {
    const { event_id, ticket_count, member_id } = req.body;
    const count = parseInt(ticket_count, 10);
    const clientToken = req.headers.authorization?.split(' ')[1];

    if (!clientToken) return res.status(401).json({ message: "토큰이 없습니다." });

    try {
        /* (필요시 토큰 검증 로직 주석 해제)
        const redisData = await redis.hGetAll(`AUTH:MEMBER:${member_id}`);
        if (!redisData || Object.keys(redisData).length === 0 || redisData.token !== clientToken) {
            return res.status(401).json({ message: "유효하지 않은 토큰입니다." });
        }
        */

        // [1] 서비스 계층 호출 (재고 차감, 데이터 검증)
        const bookingDetail = await resService.validateAndPrepare(event_id, count, member_id);
        
        // [2] DB에 PENDING 상태로 예약 기록 저장
        await resService.makeReservation({
            event_id,
            ticket_count: count,
            total_price: bookingDetail.totalPrice,
            ticket_code: bookingDetail.ticketCode
        }, member_id);

        // [3] 결제 서버로 RabbitMQ 메시지 발송
        const messagePayload = {
            orderId: bookingDetail.ticketCode,
            memberId: Number(member_id),
            amount: Number(bookingDetail.totalPrice),
            type: "PAYMENT",
            eventTitle: bookingDetail.eventTitle,
            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE 
        };
        
        await publishToQueue(ROUTING_KEYS.PAY_REQUEST, messagePayload);
        console.log(`🚀 [MQ 전송] 결제 요청 발송 완료: ${bookingDetail.ticketCode}`);

        // [4] 202 Accepted 응답 (비동기 처리 진행 중)
        res.status(202).json({ 
            message: "예약 요청이 성공적으로 접수되었습니다.",
            ticket_id: bookingDetail.ticketCode,
            total_price: bookingDetail.totalPrice
        });

    } catch (error) {
        console.error("❌ 예약 처리 중 오류:", error);
        res.status(error.status || 500).json({ message: error.message || "서버 오류" });
    }
};

// [2] 특정 유저의 예약 상태 확인
exports.getReservationStatus = async (req, res) => {
    try {
        const { userId } = req.params;
        // 향후 DB에서 해당 유저의 최근 예약 상태를 조회하는 로직 구현
        res.json({ message: "조회 기능 준비 중", userId });
    } catch (error) {
        console.error("❌ 예약 상태 조회 오류:", error);
        res.status(500).json({ message: "상태 조회 중 오류 발생" });
    }
};

// [3] 환불 요청 접수
exports.requestRefund = async (req, res) => {
    const { ticket_code, member_id } = req.body; 

    try {
        // [1] 서비스에서 환불 가능 여부 검증 및 처리
        const refundPayload = await resService.processRefund(ticket_code, member_id);

        // [2] 결제 서버로 환불 메시지 발송
        const messagePayload = {
            orderId: refundPayload.ticket_code,
            memberId: Number(refundPayload.member_id),
            amount: Number(refundPayload.cancel_amount),
            type: "REFUND",
            replyRoutingKey: ROUTING_KEYS.STATUS_UPDATE
        };

        await publishToQueue(ROUTING_KEYS.PAY_REQUEST, messagePayload);
        console.log(`🚀 [MQ 전송] 환불 요청 발송 완료: ${refundPayload.ticket_code}`);

        res.status(200).json({ message: "환불 요청이 접수되었습니다." });
    } catch (error) {
        console.error("❌ 환불 처리 오류:", error);
        res.status(error.status || 500).json({ message: error.message });
    }
};