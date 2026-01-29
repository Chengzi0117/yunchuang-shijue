# 云创 AI 视觉系列 - VPS 部署手册

本手册指导您如何将项目部署到独立的 VPS 服务器，以解除 Vercel 的 4.5MB 体积限制。

## 1. 基础环境准备

### 系统建议
- OS: Ubuntu 22.04 LTS (推荐) 或 Debian 11+
- 配置: 至少 1核1G (单纯做代理和前端，负载极低)

### 安装 Node.js
```bash
# 安装 NodeSource 存储库
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 安装进程管理器 PM2
```bash
sudo npm install pm2 -g
```

---

## 2. 部署代码

1. **克隆仓库**：
   ```bash
   cd /var/www
   git clone https://github.com/Chengzi0117/yunchuang-shijue.git
   cd yunchuang-shijue
   ```

2. **(可选) 如果您有后端代理脚本**：
   如果您要在 VPS 上跑中转 Node 脚本，请进入对应目录执行：
   ```bash
   npm install
   pm2 start index.js --name "ai-proxy"
   ```

---

## 3. 安装与配置 Nginx (解除体积限制的核心)

### 安装 Nginx
```bash
sudo apt update
sudo apt install nginx -y
```

### 配置虚拟主机
创建一个新的配置文件：`sudo nano /etc/nginx/sites-available/ai-vision`

粘贴以下配置（请将 `yourdomain.com` 替换为您的域名或 IP）：

```nginx
server {
    listen 80;
    server_name yourdomain.com; # 替换为您的域名或IP

    # --- 核心配置：解除 4.5MB 限制 ---
    client_max_body_size 50M;   # 设置允许的请求体为 50MB
    proxy_read_timeout 300s;     # 设置超时时间为 5分钟
    proxy_send_timeout 300s;

    # 静态前端资源目录
    location / {
        root /var/www/yunchuang-shijue/gemini系列_版本v.1.0.0;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # 反向代理：解决跨域并中转到多个 API 接口
    # 模拟 Vercel 的 rewrites 逻辑
    location /api/proxy3/ {
        proxy_pass http://152.53.166.72:3000/;
        proxy_set_header Host $host;
    }

    location /api/proxy4/ {
        proxy_pass http://157.254.18.127:3000/;
        proxy_set_header Host $host;
    }

    location /api/proxy5/ {
        proxy_pass http://154.36.173.51:3000/;
        proxy_set_header Host $host;
    }
}
```

启用配置并重启 Nginx：
```bash
sudo ln -s /etc/nginx/sites-available/ai-vision /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## 4. 获取 SSL 证书 (开启 HTTPS)
浏览器调用摄像头或某些高级特性需要 HTTPS。

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

---

## 5. 常见问题排查

- **413 Request Entity Too Large**: 检查 Nginx 配置文件中的 `client_max_body_size` 是否已按上述步骤修改。
- **504 Gateway Timeout**: 检查 `proxy_read_timeout` 是否已调大。
- **权限问题**: 确保 Nginx 对 `/var/www/yunchuang-shijue` 目录有读取权限：`sudo chown -R www-data:www-data /var/www/yunchuang-shijue`

---

## 6. Antigravity 的建议
即使部署在 VPS 上，**前端压缩** 仍然是最佳实践。它可以：
1. 显著减少用户上传时的等待时间。
2. 节省 VPS 的带宽流量。
3. 降低 API 中转服务器的负载压力。
