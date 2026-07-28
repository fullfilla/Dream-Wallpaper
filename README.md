# Dream Wallpaper

一个面向 Windows 的图片与视频动态壁纸管理器，使用 Electron 和轻量级 C# 原生辅助程序构建。

## 功能

- 导入并管理图片、GIF 和视频壁纸
- 静态壁纸与动态桌面壁纸切换
- 填充、适应、拉伸和居中等显示模式
- 壁纸定时轮换与随机轮换
- 锁屏壁纸同步
- 动态壁纸展示窗口
- 系统托盘常驻与开机启动
- NSIS 安装包和便携版构建

## 环境要求

- Windows 10 或 Windows 11
- Node.js 22 或更高版本
- npm
- Windows 自带的 .NET Framework 4.x

## 本地运行

```powershell
npm install
npm start
```

`npm start` 会先编译 `native` 目录中的 C# 辅助程序，然后启动 Electron 应用。

## 代码检查

```powershell
npm run check
npm run build:native
```

## 构建

```powershell
# 解包目录
npm run build:dir

# NSIS 安装包
npm run build:setup

# 便携版
npm run build:portable
```

构建结果会输出到 `release` 目录。

## 项目结构

```text
assets/      默认壁纸和托盘图标
build/       安装器配置
native/      Windows 原生辅助程序源码
scripts/     构建脚本
ui/          Electron 渲染进程界面
main.cjs     Electron 主进程
```

## 安全说明

动态壁纸需要将原生窗口挂载到 Windows 桌面窗口层级。锁屏同步使用 Windows Runtime API。建议只导入可信来源的本地媒体文件。

## License

MIT
