# Settled UI terms

## Settled terms

Terms the user decided after back-and-forth review. Use them for their
concept and never reintroduce a rejected wording. When the user settles
a new term after review, add a row here.

| Concept | en | zh-CN |
|---|---|---|
| Configured M3U/Xtream input | Source | 播放源 |
| One M3U list | Playlist | 播放列表 |
| EPG view | Guide / Program Guide | 节目指南 |
| Catch-up | Catch-up | 回看 |
| Timeshift | Timeshift | 时移 |
| Watchlist | Watchlist | 稍后观看 |
| Current / next program | NOW / Up next | 当前 / 即将播放 |
| Resume playback | Resume | 继续播放 |
| EPG time offset | EPG time correction | EPG 时间校正 |
| Audio track | Audio track | 音轨 |
| Animation modes | Full / Reduced / Essential | 完整 / 均衡 / 基础 |
| Parental feature toggle | Use parental controls | 开启家长控制 |
| PIN re-ask timing | Ask for PIN again | 再次要求 PIN |
| Item that differs from its group | Set separately | 单独设置 |
| Group with some items locked | Partly locked | 部分锁定 |
| Xtream live category filter | Live categories | 直播分类 |
| Catalog sort field | Sort by | 排序方式 |
| Server catalog order | Default | 默认 |
| Catalog sort fields | Date added / Rating / Year | 加入日期 / 评分 / 年份 |
| Name sort direction | A–Z / Z–A | A–Z / Z–A |
| Date added / Year sort direction | Newest / Oldest | 最新 / 最早 |
| Rating sort direction | Highest / Lowest | 最高 / 最低 |
| Header-channel playback setting | HTTP headers | HTTP 请求头 |
| Header playback modes | Off / Media service / Local proxy | 关闭 / 媒体服务 / 本地代理 |
| Catalog genre filter | Genre / All genres | 类型 / 全部类型 |
| Catalog title filter | Show: All titles / Not watched / Watched / Hidden | 显示：全部 / 未观看 / 已观看 / 已隐藏 |
| Watched state and actions | Watched / Mark as watched / Mark as not watched | 已观看 / 标记为已观看 / 标记为未观看 |
| Season watched actions | Mark season as watched / Mark season as not watched | 将本季标记为已观看 / 将本季标记为未观看 |
| Hiding a title | Hide / Unhide | 隐藏 / 取消隐藏 |
| Player aspect ratio setting | Aspect Ratio | 画面比例 |
| Aspect ratio modes | Auto / 16:9 / 4:3 / Zoom | 自动 / 16:9 / 4:3 / 缩放 |
| Video quality setting | Video quality (menu: Video Quality) | 画质 |
| Video quality options | Auto / Highest / Up to 4K / Up to 1080p / Up to 720p / Lowest | 自动 / 最高画质 / 最高 4K / 最高 1080p / 最高 720p / 最低画质 |
| Following the setting (menu row) | Default · {value} | 默认 · {value} |
| A variant (menu row) | {resolution} · {bitrate} Mbps | {resolution} · {bitrate} Mbps |
| Guide layout setting | Program guide layout | 节目指南布局 |
| Guide layouts | Channel schedule / Timeline | 频道节目单 / 时间轴 |
| Empty guide slot | No information | 暂无节目信息 |
| Jump the guide to the current time | Back to now | 回到现在 |
| Tune a channel live from an aired program without catch-up or a row without program info | Watch live | 观看直播 |
| Optional LLM-powered features (section) | AI features | AI 功能 |
| AI master toggle | Use AI features | 开启 AI 功能 |
| LLM endpoint address | Server URL | 服务器网址 |
| A hosted AI server, as an example in the Server URL hint | online AI service | 在线 AI 服务 |
| A model the user runs on a LAN computer, as an example in the Server URL hint | local model on your home network | 家庭网络中的本地模型 |
| Address of a playlist or Xtream server, everywhere incl. the phone page | Playlist URL / Server URL | 播放列表网址 / 服务器网址 |
| LLM model id | Model | 模型 |
| LLM prompt budget | Context size | 上下文长度 |
| Gateway-only request headers | Extra HTTP headers | 额外 HTTP 请求头 |
| Endpoint check | Test connection | 测试连接 |
| LLM daily caps | Daily request limit / Daily token limit / No limit | 每日请求上限 / 每日 Token 上限 / 无限制 |
| LLM token | token | Token |
| Stored AI output (cache category) | AI results | AI 结果 |
| Translate subtitles (menu row; endonym after a colon outside en) | Translate to {language} | 翻译为：{language} |
| AI-translated subtitle entry | {name} · AI translation | {name} · AI 翻译 |
| Subtitle translation progress / failure | Translating subtitles… {percent}% / Subtitle translation failed | 正在翻译字幕… {percent}% / 字幕翻译失败 |
| Daily cap hit during a task | Daily AI limit reached. Translation paused. | 已达到每日 AI 上限，翻译已暂停。 |
| AI-picked EPG mapping row (badge) | AI suggestion | AI 推荐 |
| Rule-based similar guide channels (caption) | Similar names | 相似名称 |
| AI-suggested search terms on top of built-in multilingual matching (setting) | AI-enhanced multilingual search | AI 增强多语言搜索 |
| Results an expanded query added (Search) | Including results for {terms} | 还包括以下内容的结果：{terms} |

## Rejected wordings

Never reintroduce these for the concept named.

| Concept | Rejected | Use instead |
|---|---|---|
| Watchlist | 片单 | 稍后观看 |
| Watched state | 已看 / 未看, played / 已播放, unwatched | Watched / Not watched, 已观看 / 未观看 |
| HTTP headers | HTTP 标头 | HTTP 请求头 |
| Header playback mode | Luna / System player | Media service / Local proxy |
| Current program | 正在播放 | 当前 |
| EPG view | 节目单 (频道节目单 names one channel's schedule) | 节目指南 |
| All channels | 全局频道 / "Global" | — |
| Spelling | "programme" | program |
| AI multilingual search setting | Multilingual search (implies off = no multilingual matching), Multilingual search with AI / AI multilingual search / AI 多语言搜索, AI search suggestions / AI 搜索建议 (autocomplete), Search in other languages, Smart search, AI query expansion | AI-enhanced multilingual search / AI 增强多语言搜索 |
| Expanded-query results line | Also searched: …, Showing results for … | Including results for … |
| Sort direction | Ascending / Descending / 升序 / 降序 / Asc / Desc, 最旧 | A–Z / Newest / Highest, 最早 |
| Set separately | "Exception" / 例外 | Set separately / 单独设置 |
| Partly locked | "Mixed" / 混合 | Partly locked / 部分锁定 |
| Aspect ratio | 宽高比 | 画面比例 |
| Aspect modes | 原始 / 满屏 / 填充 | 自动 / 16:9 / 4:3 / 缩放 |
| Video quality | 清晰度 | 画质 |
| Quality options | Data saver / 省流量, Prefer highest / Prefer lowest | Highest / Lowest |
| Guide layouts | List / Grid / 列表 / 网格, Single channel / Channel grid, Full guide, three-pane | Channel schedule / Timeline |
| Watch live | Go live / Tune in / 返回直播 / 收看直播 | Watch live / 观看直播 |
| LLM endpoint | an "AI provider" picker / Provider / 服务商 | Server URL / 服务器网址 (any OpenAI-compatible server) |
| AI server examples (hints, placeholders, docs, setup page) | Naming a specific AI provider, service, or model, or prefilling its address or model | online AI service / local model on your home network, 在线 AI 服务 / 家庭网络中的本地模型 |
| AI features | Smart features / 智能功能 | AI features / AI 功能 |
| LLM tokens | 令牌, 词元 | Token |
| Endpoint address | Endpoint / 终端 / Base URL | Server URL |
| zh address labels | 服务器 URL, 播放列表 URL | 服务器网址, 播放列表网址 |
| AI translation label | Auto-translated / Machine translation / 自动翻译 / 机器翻译 | AI translation / AI 翻译 |
| Daily cap toast | quota / 配额 (that is the provider rate limit) | Daily AI limit / 每日 AI 上限 |
| AI-picked row | Suggested by AI / AI pick / Recommended / AI 建议 | AI suggestion / AI 推荐 |
| Similar guide channels | Closest matches / 相近的频道 / 类似频道 | Similar names / 相似名称 |
