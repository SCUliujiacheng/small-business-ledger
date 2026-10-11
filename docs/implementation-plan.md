# 小本账 Implementation Plan

> 执行方式：按独立文件范围并行开发，根代理集成并进行一次完整独立审查。用户已委托产品和发布决定，不等待逐项确认。

**Goal:** 一个可在本机运行、可以记录业务并复核结果的中文经营账本，发布到 SCUliujiacheng/small-business-ledger。
**Architecture:** React/Vite → FastAPI → SQLite。整数分、独立收付日期、只增记或作废。
**Tech Stack:** Python 3.12, uv, FastAPI, SQLite, React, Vite, TypeScript, pytest, Playwright。
**Spec:** docs/design.md；接口以 docs/api-contract.md 为准。

## Global Constraints

只改新项目目录。不得触碰旧四个项目。无真实财务数据，无公开账本部署。无付费API。钱不用浮点算。未知输入拒绝、导入恢复事务化、空库启动；错误更正可追踪。中文自然说明，不编造作者经历、业绩或生产成熟度。

## Review Focus

跨期收款与利润是否分开；全日期累计未收付款；作废重算及反向依赖；并发付款超额；导入验证到提交的竞态；restore绕过数据约束；同源保护、DNS rebinding、CSV公式注入和XSS；空库、零销售、亏损、手机表单、双击保存。

## Tasks

1. 后端与领域（代理）：先写金额/业务/收付款/日期范围/并发测试并看到失败，再实现models/store/reports/app；pytest全套绿。只改指定src模块、test_core.py。
2. 前端（代理）：按设计图与接口实现界面；格式转换与金额计算测试先行；空库/错误/保存待处理状态真实；React组件拆分，npm test + build。
3. 数据与发布（根代理）：先写CSV/恢复/安全测试，再实现transfer.py；编写运行脚本、CI、说明书、示例。运行全部后端测试及前端构建。
4. 复核：独立审查计算和迁移安全；真实浏览器桌面与手机操作录入→分次收款→报表→作废→导入→备份恢复；对比设计图和实现图。
5. 发布：检索密钥/本地账目；建公开仓库、push、检查GitHub CI；交付实际截图、链接及限制。

## Progress

- [x] 范围、计算口径和接口确定。
- [ ] 后端与领域。
- [ ] 前端。
- [ ] 导入、备份与文档。
- [ ] 集成和独立审查。
- [ ] GitHub 发布与 CI。
