# seotda
섯다 시뮬레이터

# AWS - EC2 - 인스턴스
https://us-east-2.console.aws.amazon.com/ec2/home?region=us-east-2#Instances:v=3;$case=tags:true%5C,client:false;$regex=tags:false%5C,client:false

## 재부팅 시 public IP로 변경
sudo nano /etc/nginx/conf.d/seotda.conf

# pm2로 서버 시작
cd seotda
pm2 start server.js

# link
http://[public IP]:5000/
