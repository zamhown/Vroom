# 品牌资源

Vroom 使用黑白极简 V 字标：深色圆角方形底，白色开口 V，保持小尺寸下的辨识度。品牌图形不承载任何业务标签语义。

唯一可编辑图形源为 `resources/branding/vroom.svg`。执行 `node scripts/sync-branding.mjs` 同步网页 favicon、MAUI 背景/前景图标与启动屏。MAUI 生成各平台图标尺寸；网页直接使用 SVG。

`node scripts/sync-branding.mjs --check` 和前端构建检查生成结果是否一致。原生界面颜色仍由 Spectrum token 脚本生成；该脚本不再覆盖品牌图形。不要手工编辑生成的副本。
