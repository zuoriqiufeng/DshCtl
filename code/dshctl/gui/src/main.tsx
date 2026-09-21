import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import App from './App.tsx'
import ErrorBoundary from './ErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <ConfigProvider
    locale={zhCN}
    theme={{
      algorithm: theme.defaultAlgorithm,
      token: {
        // 背景三级拉开（Linear/Geist canvas——全纯白是简陋头号来源）
        colorBgLayout: '#fafafa',
        colorBgContainer: '#ffffff',
        colorBgElevated: '#ffffff',
        colorBorder: '#e3e5e8',
        colorSplit: '#eef0f1',
        // 文字三档：全部 ≥4.5:1（原 #8c96a6 对白仅 2.99:1）
        colorText: '#1a1d21',
        colorTextSecondary: '#5c6470',
        colorTextTertiary: '#8a9099',
        colorTextQuaternary: '#c2c7cd',
        // accent 蓝：只留给链接/选中/focus（主按钮由 Button 组件 token 改近黑）
        colorPrimary: '#1677ff',
        colorPrimaryHover: '#4096ff',
        colorLink: '#1677ff',
        colorSuccess: '#52c41a',
        colorWarning: '#faad14',
        colorError: '#ff4d4f',
        // 圆角三档：控件 6 / 卡 12（LG）/ 弹层走 LG+
        borderRadius: 6,
        borderRadiusSM: 4,
        borderRadiusXS: 2,
        borderRadiusLG: 12,
        fontSize: 14,
        fontWeightStrong: 600,
        controlHeight: 36,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
        // 阴影：必叠 1px ring（Geist 手法）；卡零影由 cardStyle/SHADOW 承担
        boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 1px 2px rgba(16,24,40,.06)',
        boxShadowSecondary: '0 8px 24px rgba(16,24,40,.10)',
        // 动效：hover 0.15 / 面板 0.2（原 0.1 偏机械、0.3 略拖）
        motionDurationFast: '0.15s',
        motionDurationMid: '0.2s',
        motionDurationSlow: '0.25s',
        wireframe: false,
      },
      components: {
        Layout: { siderBg: '#0e1830', headerBg: '#ffffff', bodyBg: '#fafafa', headerHeight: 56 },
        Card: { headerFontSize: 14, headerHeight: 48, bodyPadding: 20, bodyPaddingSM: 16 },
        // 主按钮近黑（Linear/Geist DNA 关键单点：黑按钮 + 蓝 accent 让位）
        Button: { colorPrimary: '#18181b', colorPrimaryHover: '#27272a', primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500, paddingInline: 16 },
        Table: { headerBg: '#f4f5f6', headerColor: '#5c6470', headerSplitColor: 'transparent', rowHoverBg: '#f4f7fb', borderColor: '#eef0f1', cellPaddingBlock: 12, cellPaddingInline: 16 },
        // ink bar 粗细不是 token（antd 默认 2px 已达标——原 inkBarWidth:3 是无效覆盖且类型报错）
        Tabs: { inkBarColor: '#1677ff', itemSelectedColor: '#1677ff', itemHoverColor: '#4096ff' },
        Input: { activeShadow: '0 0 0 2px rgba(22,119,255,.12)', hoverBorderColor: '#1677ff', paddingInline: 12 },
        Select: { optionSelectedBg: '#eef4ff' },
        Tag: { defaultBg: '#f4f5f6', defaultColor: '#5c6470' },
        Menu: { itemBg: 'transparent', itemSelectedBg: 'rgba(255,255,255,.08)', itemColor: 'rgba(255,255,255,.65)', itemSelectedColor: '#ffffff', groupTitleColor: 'rgba(255,255,255,.35)', itemBorderRadius: 8 },
      },
    }}
  >
    <AntApp>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </AntApp>
  </ConfigProvider>,
)
