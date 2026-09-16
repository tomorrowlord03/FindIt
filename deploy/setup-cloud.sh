#!/usr/bin/env bash
# Automated cloud setup script for FindIt on Ubuntu (AWS EC2 / Lightsail)
set -euo pipefail

echo "==> Updating apt repositories and installing packages..."
export DEBIAN_FRONTEND=noninteractive
sudo apt update -y
sudo apt install -y build-essential git sqlite3 libsqlite3-dev nginx curl

APP_DIR="/home/ubuntu/FindIt"

if [ ! -d "$APP_DIR" ]; then
  echo "==> Cloning FindIt repository..."
  git clone https://github.com/tomorrowlord03/FindIt.git "$APP_DIR"
else
  echo "==> Updating existing repository..."
  cd "$APP_DIR"
  git pull origin main
fi

echo "==> Building C++ server..."
cd "$APP_DIR/server/cpp"
mkdir -p build
g++ -std=c++17 -O2 -o findit-server main.cpp -lsqlite3 -lpthread -ldl

echo "==> Configuring systemd service..."
sudo cp "$APP_DIR/deploy/findit.service" /etc/systemd/system/findit.service
sudo systemctl daemon-reload
sudo systemctl enable --now findit
sudo systemctl restart findit

echo "==> Configuring Nginx reverse proxy..."
sudo cp "$APP_DIR/deploy/nginx-findit.conf" /etc/nginx/sites-available/default
sudo nginx -t
sudo systemctl restart nginx

echo "==> Verifying local backend health..."
sleep 2
if curl -s http://127.0.0.1:3000/reports | grep -q '\['; then
  echo "==> SUCCESS! FindIt backend is healthy and responding."
else
  echo "==> WARNING: Backend did not return expected response. Check: sudo journalctl -u findit -n 50"
fi

PUBLIC_IP=$(curl -s http://checkip.amazonaws.com || curl -s https://ifconfig.me || echo "your-server-ip")
echo "========================================================="
echo " FindIt is live at: http://${PUBLIC_IP}/"
echo "========================================================="
