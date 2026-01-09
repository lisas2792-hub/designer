# 使用官方 Node LTS 版本
FROM node:20-slim

# 設定環境為 production
ENV NODE_ENV=production

# 建立容器內工作目錄
WORKDIR /usr/src/app

# 先複製 package.json / package-lock.json（如果有）
COPY package*.json ./

# 安裝正式環境依賴
RUN npm install --only=production

# 再把整個專案丟進來
COPY . .

# Cloud Run 會透過 PORT 環境變數指定要聽的 port
# ENV PORT=8080    (Cloud Run 會自己注入 PORT) 
# EXPOSE 只是文件化
EXPOSE 8080

# 啟動指令：要對應 package.json 的 "start": "node server.js"
CMD ["npm", "start"]
