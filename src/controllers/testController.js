// testController.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const resService = require('../services/resService');
const redis = require('../config/redisClient'); // Redis 연결 설정
const amqp = require('amqplib'); // RabbitMQ 연결 설정


const handleTestRequest = (req, res, next) => {
    try {
        // 서버 터미널에 로그 출력
        console.log("요청받음");

        // 클라이언트(Gateway)로 정상 응답 반환
        return res.status(200).json({
            success: true,
            message: "요청받음"
        });
    } catch (error) {
        // 예외 발생 시 에러 처리 미들웨어로 전달
        next(error);
    }
};

module.exports = {
    handleTestRequest
};