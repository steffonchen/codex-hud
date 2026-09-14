# Skills 真实结构样本

- `single-skill.md`：本机系统 openai-docs 定义的 name/description frontmatter；正文移除。
- `skill-with-version.md`：本机用户 archify 定义第 2、3、5、6 行；保留 metadata.version 字符串 `2.16`，正文移除。
- `runtime-catalog.jsonl`：rollout-2026-09-12T10-02-49-01a0935a-6431-7b12-b5dd-704c48848e53.jsonl:3 的 developer message。保留 skills_instructions、Skill roots、Available skills 的真实结构、14 项名称与别名引用；绝对根目录匿名化，描述替换。

目录声明仅证明当前任务列出这些技能。未取得逐技能 loaded、active 或 failed 运行事件。移除文件、损坏定义、权限错误、禁用及活动状态只在文件或归一化接口测试中构造，不充当真实 runtime fixture。插件版本不作为 Skill version。
