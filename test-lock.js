// test-lock.js
const axios = require('axios');

async function heavyTest() {
    const url = 'http://localhost:8082/reserve';
    const count = 20; 
    
    // 💡 토큰 앞에 'Bearer '가 중복으로 들어가지 않았는지, 따옴표 안에 공백은 없는지 확인!  
    //node test-lock.js
    const rawToken = 'eyJhbGciOiJIUzM4NCJ9.eyJzdWIiOiIxNiIsInJvbGUiOiJVU0VSIiwiaWF0IjoxNzcyNzgyODIzLCJleHAiOjE3NzI3ODY0MjN9.MWLYtNNTWxyLqoyntzsD-x9HLBKL4FjJJ_nNnLSSxEMzUdaVZuxGGmWdc0i_cQRZ'; 
    const token = rawToken.trim(); 

    console.log(`🔥 [동시성 테스트] ${count}개의 예약을 시도합니다!`);

    const requests = Array(count).fill().map((_, i) => {
        return axios.post(url, {
            event_id: 1,      
            ticket_count: 1,
            member_id: 16     
        }, {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }).then(res => {
            console.log(`✅ [${i+1}] 성공: ${res.data.ticket_id}`);
        }).catch(err => {
            // 🔍 에러의 정체를 밝히는 로그
            const status = err.response?.status; // 401, 500 등
            const msg = err.response?.data?.message || err.message;
            console.log(`❌ [${i+1}] 실패: ${status} - ${msg}`);
        });
    });

    await Promise.all(requests);
    console.log("\n🏁 테스트 끝!");
}

heavyTest();