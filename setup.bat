@echo off
echo [1/3] npm 패키지 설치 중...
call npm install

echo [2/3] Prisma 클라이언트 생성 중...
call npx prisma generate

echo [3/3] DB 마이그레이션 반영 중...
call npx prisma migrate deploy

echo 모든 세팅이 완료되었습니다!
pause