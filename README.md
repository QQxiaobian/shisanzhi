# 十三支 · THIRTEEN

四人联机扑克对战游戏，完整实现「单张 / 对子 / 炸弹 / 千弹 / 撞」规则。服务端权威判定，浏览器即可游玩，内置管理员后台与用户管理，支持 Docker 一键部署。

## 功能一览

- **联机对战**：4 个座位，Socket.IO 实时同步；断线可重连，掉线玩家自动托管。
- **机器人补位**：房主可添加机器人，4 人随时开局。
- **管理员后台** `/admin`：查看统计、创建用户、修改密码、设置管理员、禁用/删除账号、查看活跃房间。
- **严格规则校验**：所有出牌、撞、Pass、收牌、名次、上缴、计分均由服务端判定，客户端无法绕过。
- **像素风 UI**：纯 CSS / SVG 绘制牌桌、卡牌与头像，无外部图片依赖。
- **持久化**：用户与战绩写入 `data/db.json`（Docker 使用数据卷）。

## 快速开始（本地）

```bash
git clone https://github.com/QQxiaobian/shisanzhi.git
cd shisanzhi
npm install
npm start
```

打开 http://localhost:3000 游玩，管理员后台 http://localhost:3000/admin 。

默认管理员：`admin / admin123`（建议首次登录后修改密码）。

## Docker 部署（无需拉取源码）

只需一个 `docker-compose.yml` 即可部署，镜像托管在 GitHub Container Registry。

```bash
# 1) 下载 compose 文件（或复制仓库中的 docker-compose.yml）
wget https://raw.githubusercontent.com/QQxiaobian/shisanzhi/main/docker-compose.yml

# 2) 启动
docker compose up -d
```

打开 http://localhost:3000 。

数据保存在命名卷 `thirteen-data` 中，重建容器不会丢失用户与战绩。

自定义管理员与环境变量（可在 `.env` 或命令行中提供）：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='your-strong-password' \
TOKEN_SECRET='a-long-random-string' \
docker compose up -d
```

> 镜像由 GitHub Actions 自动构建推送：`ghcr.io/qqxiaobian/shisanzhi:latest`。
> 如需本地构建镜像，克隆仓库后执行 `docker build -t ghcr.io/qqxiaobian/shisanzhi:latest .`，再运行 `docker compose up -d`。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ADMIN_USERNAME` | `admin` | 首次启动创建的管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 首次启动创建的管理员密码 |
| `TOKEN_SECRET` | 自动生成 | 登录 token 签名密钥，生产环境请固定 |
| `DATA_DIR` | `./data` | 数据文件目录 |

## 玩法规则（实现要点）

- 4 人、标准 52 张（无王），每人 13 张。
- 合法牌型仅四种：**单张、对子（2 张）、炸弹（3 张）、千弹（4 张）**。
- 牌力：`2 > A > K > Q > J > 10 > 9 > 8 > 7 > 6 > 5 > 4 > 3`。
- 持有 **黑桃 3** 的玩家强制首出，且首出牌组必须包含黑桃 3。
- 压制优先级：**千弹 > 炸弹 > 撞 > 普通同牌型**。
- **撞**：桌面基准为单张时，用**同点数对子**抢撞，5 秒倒计时内先提交者成功；撞只能被炸弹、千弹压制。
- **能压必须压**：存在合规可压制的牌时禁止 Pass。
- **禁止留 2 收尾**：出牌后若剩余手牌全为 2，该出牌被拦截。
- 连续三家 Pass（已出完玩家不计）结束本轮，最后出牌者收走桌面牌并获得下一轮先手。
- 按出完手牌顺序排名；第四名须向第一名上缴 **3 张**牌（若剩余手牌不足 3 张，用本局收牌补足）。
- 结算时第四名的剩余手牌计入其收牌数，上缴的牌由第四名转给第一名（第四名收牌 -3，第一名收牌 +3），因此四人收牌合计恒为 **52 张**，本局输赢总和恒为 **0**。
- 计分：`收牌数 - 13`，多局累加；牌局进行中每个座位的收牌数实时显示。
- 下一局发牌权交给上一局第四名。

## 项目结构

```
server.js              Express + Socket.IO 入口、REST API、管理员鉴权
src/
  auth.js              HMAC-SHA256 token 签发/校验、中间件
  store.js             用户与战绩 JSON 持久化、管理员初始化
  rooms.js             房间/座位/机器人/重连/游戏推送
  game/
    rules.js           纯函数规则引擎（牌型、压制、撞、枚举）
    game.js            游戏状态机（回合、计时器、结算、托管）
public/
  index.html           游戏单页
  admin.html           管理后台
  css/style.css        像素风样式
  css/admin.css        后台样式
  js/app.js            客户端渲染与交互
  js/admin.js          后台逻辑
test/
  rules.test.js        规则单元测试
  e2e-socket.js        4 人联机端到端测试
```

## 测试

```bash
npm test
node test/e2e-socket.js http://localhost:3000
```

端到端测试会自动创建测试账号、开房、4 个 socket 打完整一局，并校验黑桃 3 首出、强制出牌、名次、计分与上缴。

## 素材方案

全部素材由 CSS / SVG 生成，仓库内无图片资源：

- 扑克牌：CSS 渐变、边框、花色字符（♠ ♥ ♣ ♦）。
- 桌面与按钮：像素化 `box-shadow` 边框、扫描线与网格背景。
- 玩家头像：内联 SVG 像素机甲图案。
- 动效：CSS `transition` / `keyframes`（发牌高亮、撞提示、计时条）。

如需替换为美术素材，只需在 `public/css` 中覆盖对应类名，或在 `public/js/app.js` 的渲染函数中替换为 `<img>`。
