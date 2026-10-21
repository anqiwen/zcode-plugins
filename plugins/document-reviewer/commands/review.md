---
description: 在 Document Reviewer 中打开并批注文档
argument-hint: <工作区相对路径>
---

# /review — 文档批注

对 `$ARGUMENTS` 指定的文档打开 Document Reviewer 面板：

1. 若 `$ARGUMENTS` 为空，请用户提供工作区相对路径（支持 `.md` / `.markdown` / `.txt` / `.pdf` / `.docx`）。
2. 若参数是目录或多个文件，列出其中可批注的文档，让用户选择。
3. 调用 `show_reviewer` 内联打开面板，然后调用 `open_document`，`path` 传工作区相对路径。
4. 如果路径是工作区外的绝对路径：不要调用 `open_external_document`（该入口仅面板可用）；请用户在面板左侧点「打开工作区外文件」并输入该路径。
5. 面板打开后由用户自己选中文字、添加批注；不要替用户生成批注内容。

收到批注发送消息后，按 Document Reviewer 技能处理：先备份 `.bak`，逐条定位修改，再提示用户在面板中刷新。
