import { Component, type ReactNode } from 'react'
import { Result, Button, Collapse, Typography, Space, App as AntApp } from 'antd'
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons'

/** 全局错误边界：渲染崩溃显示友好页（防白屏），细节可展开+复制 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      const detail = String(this.state.error?.stack ?? this.state.error)
      return (
        <AntApp>
          <Result status="error" title="页面渲染出错"
            subTitle="某个组件渲染时抛了异常（详情可展开查看并复制反馈）。重新加载通常可恢复；反复出现请把堆栈发给维护者。"
            extra={<Space>
              <Button type="primary" icon={<ReloadOutlined />} onClick={() => { this.setState({ error: null }); location.reload() }}>重新加载</Button>
              <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard?.writeText(detail)}>复制错误详情</Button>
            </Space>}>
            <Collapse size="small" items={[{
              key: 'stack', label: <Typography.Text type="secondary" style={{ fontSize: 13 }}>错误详情</Typography.Text>,
              children: <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', fontSize: 12, textAlign: 'left' }}>{detail}</pre>,
            }]} />
          </Result>
        </AntApp>
      )
    }
    return this.props.children
  }
}
