# DSH 通用渲染宿主设计

用户在 2026-11-10 已确认按通用宿主流程实现。沿用当前 PR #21；只运行后台命令，后台打包安装，不打开或重载 VS Code 窗口。

目标：通过 Copilot chatOutputRenderer 的 Webview 承载原 GenUI 0.15.0 完整 embed runtime，而非逐组件转换。建立可扩展的 renderer id/version + data + viewId 协议，传递界面、资源和会话动作。首次实现的 renderer 为 dsh.genui 协议版本1；其他 DSH 插件可后续增加 renderer 注册，不能把未知插件数据冒充已支持界面。

统一可序列化界面：{protocol:1, renderer:{id:"dsh.genui",version:1},viewId:string,data:unknown}。host 的完整围栏包装可追加 routeToken；token 只由 extension 根据当前绑定会话生成。DSH rich result 从 presentationMeta 保留原 spec，错误结果不生成成功视图。RichViewSSP 记录界面，可重放为完成的 dsh-ui fenced Markdown。普通 dsh-ui assistant 围栏也由会话绑定的流包装器处理。

Webview 消息：ready {type:"ready",protocol:1}；宿主 render {type:"render",protocol:1,view,assetBase,actionEnabled}；动作 {type:"action",protocol:1,requestId,action,payload}；宿主反馈 {type:"action-result",protocol:1,requestId,ok,error?}。所有动作以渲染实例绑定的会话传送；关闭/替换会话和忙碌状态要有明确处理，不从当前焦点聊天推断所属会话。

前端复用 GenUI embed 的校验器、组件、动作 Context 与本地交互。打包 TSX/React/CSS Modules；采用 GenUI 内置 standalone primitive alias，资源通过本地 Webview URI 提供；保留许可声明。运行时版本随安装包固定并在 manifest 中记录。保留正确 UI数据；为截图中的已知 badge.content、CSS justify 别名做保守兼容。

注册 proposed API chatOutputRenderer，贡献 codeBlockLanguageIdentifiers:["dsh-ui"] 与 application/vnd.acpilot.dsh-view+json。不支持该 API 的宿主显示可读文本/原始数据；不把 MIME 数据随意附加到 ChatToolInvocationPart。

验证必须覆盖 bridge→pipeline→SSP→Webview 数据，两个会话的动作隔离、错误数据、取消、刷新/重放、本地tabs/按钮与完整runtime资源。可用后台浏览器/DOM测试；遵守不打开 VS Code 的限制，最终 Workbench显示由用户Reload后验证，不能宣称已做可见Workbench UI测试。
