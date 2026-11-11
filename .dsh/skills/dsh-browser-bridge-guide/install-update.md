# 安装与更新

只在工具连不上、或用户问怎么更新时读。

- 工具连不上、或某个工具像是缺了：第一站是 `browser_status`，它会给出唯一的下一个
  动作。首次安装，或它的文案说扩展文件刚刷新过，用 `browser_setup` 准备文件并打开
  扩展页。
- 用户问怎么更新：让他们点扩展面板里的 **Update** 按钮（它把命令放进剪贴板），或者调
  `browser_update` 把命令打印出来交给用户自己跑 —— 两者都**不会替用户执行**，因为更新
  要写进用户的 dsh home，跑完还要在 chrome://extensions 点一下 Reload。
  **两者给的命令不一样，别混**：按钮**总是**给已发布版本的安装命令
  `curl -fsSL …/scripts/install.sh | bash`；`browser_update` 则按本机安装方式给——仓库内
  安装（checkout）是 `./scripts/install.sh`。所以**要更新的是本地 checkout 的改动时，用
  `./scripts/install.sh`（在仓库里跑），别用按钮给的那条**——那条装的是已发布版本，会把
  本地树覆盖掉。

**做完了，能指出这一条：**用户拿到的是哪条命令（Update 按钮给的已发布版，还是 `browser_update` 按本机安装方式给的），以及是否说明了要在 chrome://extensions 点 Reload。
