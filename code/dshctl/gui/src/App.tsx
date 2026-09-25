import { useState, useEffect } from 'react'
import { Layout, Menu, Typography, Tag, Space, theme, Badge, Drawer, Button, Empty } from 'antd'
import { HomeOutlined, ApartmentOutlined, RocketOutlined, AppstoreOutlined, BookOutlined, BellOutlined } from '@ant-design/icons'
import Dashboard from './pages/Dashboard.tsx'
import DomainsPage from './pages/Domains.tsx'
import UpgradePage from './pages/Upgrade.tsx'
import NewDomain from './pages/NewDomain.tsx'
import PluginsPage from './pages/Plugins.tsx'
import DomainDetail from './pages/DomainDetail.tsx'
import { GRAY, api, TAB_TILE_CSS, VERSION } from './api.tsx'
import ManualPage from './pages/Manual.tsx'

const { Sider, Header, Content, Footer } = Layout

const MENU = [
  { key: 'dash', icon: <HomeOutlined />, label: '概览' },
  { key: 'domains', icon: <ApartmentOutlined />, label: '领域' },
  { key: 'plugins', icon: <AppstoreOutlined />, label: '插件库' },
  { key: 'upgrade', icon: <RocketOutlined />, label: '升级对账' },
  { key: 'manual', icon: <BookOutlined />, label: '使用手册' },
]

/** 菜单分组（v0.5：实例登记并入概览、新建并入领域——7→5，旧 hash 链接兼容映射见 LEGACY_MENU） */
const MENU_GROUPS = [
  { label: '工作台', keys: ['dash'] },
  { label: '编排', keys: ['domains', 'plugins'] },
  { label: '运维', keys: ['upgrade'] },
  { label: '帮助', keys: ['manual'] },
]

/** 旧菜单 key → 新去向（7→5 后旧链接不 404） */
const LEGACY_MENU: Record<string, string> = { registry: 'dash', newdomain: 'domains' }

const TITLES: Record<string, { title: string; sub: string }> = {
  dash: { title: '概览', sub: '编排体系一屏总览：实例登记、领域健康、依赖状态与最近检查' },
  domains: { title: '领域', sub: '列表 + 详情：编排画布 / 概览 / check 对账 / diff / 清单编辑 / 新建' },
  plugins: { title: '插件库', sub: '插件目录与核心必须件清单——编排时从这里选插件' },
  upgrade: { title: '升级对账', sub: 'harness 更新后跑一遍：哪些领域需要跟进、能否进入升级第 3 步' },
  manual: { title: '使用手册', sub: '快速上手 · 页面速览 · DSH 体系 · 两套控制台分工 · FAQ' },
}

type Notice = { key: string; level: 'error' | 'warn' | 'info'; title: string; detail: string; nav: string; domain?: string }

/** URL hash ↔ 页面状态：#/plugins、#/domains?domain=ops&view=detail —— 刷新/分享链接不丢位置 */
const MENU_KEYS = new Set(MENU.map((m) => m.key))
export type DomainView = 'list' | 'detail' | 'new'
function parseHash(): { menu: string; domain: string; domainView: DomainView } {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (!h) return { menu: 'dash', domain: 'ops', domainView: 'list' }
  const [path, qs] = h.split('?')
  const sp = new URLSearchParams(qs ?? '')
  const raw = path ?? ''
  const menu = MENU_KEYS.has(raw) ? raw : LEGACY_MENU[raw] ?? 'dash'
  const view = sp.get('view')
  return {
    menu,
    domain: sp.get('domain') || 'ops',
    domainView: view === 'detail' ? 'detail' : view === 'new' || raw === 'newdomain' ? 'new' : 'list',
  }
}
function buildHash(menu: string, domain: string, domainView: DomainView): string {
  if (menu === 'dash') return ''
  if (menu === 'domains') return `#/${menu}?domain=${encodeURIComponent(domain)}${domainView !== 'list' ? `&view=${domainView}` : ''}`
  return `#/${menu}`
}

export default function App() {
  const [menu, setMenu] = useState(() => parseHash().menu)
  const [domain, setDomain] = useState(() => parseHash().domain)
  const [domainView, setDomainView] = useState<DomainView>(() => parseHash().domainView)
  const [notices, setNotices] = useState<Notice[]>([])
  const [bellOpen, setBellOpen] = useState(false)
  const loadNotices = () => { void api<Notice[]>('/api/notices').then((r) => setNotices(r.data ?? [])).catch(() => setNotices([])) }
  useEffect(() => { loadNotices() }, [])
  // 状态 → hash（replaceState 不产生历史条目；hashchange 支持手动改地址/前进后退）
  useEffect(() => {
    const h = buildHash(menu, domain, domainView)
    window.history.replaceState(null, '', h || window.location.pathname)
  }, [menu, domain, domainView])
  useEffect(() => {
    const onHash = () => { const s = parseHash(); setMenu(s.menu); setDomain(s.domain); setDomainView(s.domainView) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const noticeCount = notices.filter((n) => n.level !== 'info').length
  const ackNotices = (keys: string[]) => { if (keys.length) void api('/api/notices/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) }).catch(() => {}) }
  const goNotice = (n: Notice) => {
    ackNotices([n.key])
    setNotices((prev) => prev.filter((x) => x.key !== n.key))
    // 旧 nav key（registry/newdomain）映射到 7→5 后的去向
    const nav = LEGACY_MENU[n.nav] ?? n.nav
    setMenu(nav)
    if (n.domain) { setDomain(n.domain); if (nav === 'domains') setDomainView(n.nav === 'newdomain' ? 'new' : 'detail') }
    setBellOpen(false)
  }
  const { token } = theme.useToken()
  const t = TITLES[menu] ?? { title: menu, sub: '' }
  const menuItems = MENU_GROUPS.map((g) => ({
    type: 'group' as const,
    label: g.label,
    children: MENU.filter((m) => g.keys.includes(m.key)),
  }))
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={212} breakpoint="lg" collapsedWidth={0}>
        <div style={{ padding: '20px 16px 14px', color: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="/favicon.svg" width={34} height={34} alt="" style={{ borderRadius: 8 }} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 18, lineHeight: 1.2, letterSpacing: 0.5 }}>dshctl</span>
                <Tag color="blue" style={{ marginRight: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px' }}>{VERSION}</Tag>
              </div>
              <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.55)' }}>Domain Orchestration Console</div>
            </div>
          </div>
        </div>
        <Menu
          theme="dark" mode="inline" selectedKeys={[menu]}
          items={menuItems}
          onClick={(e) => setMenu(e.key)}
          style={{ borderInlineEnd: 'none', background: 'transparent' }}
        />
        <div style={{ position: 'absolute', bottom: 40, left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 11.5 }}>
          当前领域 · {domain}
        </div>
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 1px 4px rgba(0,21,41,0.08)', position: 'sticky', top: 0, zIndex: 10 }}>
          <Space align="center" size={10}>
            <Typography.Text strong style={{ fontSize: 15 }}>{t.title}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t.sub}</Typography.Text>
            {menu === 'domains' && <Tag color="blue">当前领域 · {domain}</Tag>}
          </Space>
          <Space size={16}>
            <Badge count={noticeCount} size="small" offset={[-4, 4]}>
              <Button type="text" icon={<BellOutlined style={{ fontSize: 18 }} />} onClick={() => { setBellOpen(true); loadNotices() }} />
            </Badge>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>薄壳模式：操作可复现为等价 CLI</Typography.Text>
          </Space>
        </Header>
        <Content style={{ margin: 20, maxWidth: 1280, width: '100%', alignSelf: 'center' }}>
          {menu === 'dash' && <Dashboard onNav={setMenu} onOpenDomain={(d) => { setDomain(d); setDomainView('detail'); setMenu('domains') }} />}
          {menu === 'domains' && <DomainsPage domain={domain} setDomain={setDomain} view={domainView} setView={setDomainView} onNav={setMenu} />}
          {menu === 'plugins' && <PluginsPage />}
          {menu === 'upgrade' && <UpgradePage />}
          {menu === 'manual' && <ManualPage />}
        </Content>
        <Footer style={{ textAlign: 'center', color: token.colorTextQuaternary, fontSize: 12, background: 'transparent', padding: '12px 24px' }}>
          dshctl {VERSION} · 清单驱动 / 幂等生成 / 对账校验 / 插件库
        </Footer>
        <style>{TAB_TILE_CSS}</style>
        <Drawer open={bellOpen} onClose={() => setBellOpen(false)} width={420} title={<Space><BellOutlined />提示中心</Space>}>
          {notices.length === 0
            ? <Empty description="暂无提示——一切正常" style={{ marginTop: 48 }} />
            : (['error', 'warn', 'info'] as const).map((lv) => {
              const items = notices.filter((n) => n.level === lv)
              if (!items.length) return null
              const meta = lv === 'error' ? { color: '#ff4d4f', label: '错误' } : lv === 'warn' ? { color: '#faad14', label: '警告' } : { color: '#1677ff', label: '提示' }
              return (
                <div key={lv} style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ color: meta.color, fontSize: 13 }}>{meta.label}（{items.length}）</Typography.Text>
                  <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                    {items.map((n, i) => (
                      <div key={i} onClick={() => goNotice(n)} className="card-hover" style={{
                        padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                        border: `1px solid ${meta.color}33`, borderLeft: `3px solid ${meta.color}`, background: '#fff',
                      }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{n.title}</div>
                        <div style={{ fontSize: 12, color: GRAY.weak, marginTop: 2 }}>{n.detail}</div>
                      </div>
                    ))}
                  </Space>
                </div>
              )
            })}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: '#b0bac7' }}>提示 = 静态环境（端口/信任/入库）+ 动态结果（check 失败/升级对账）聚合 · 点条目直达处理页并标记已读</div>
            {!!notices.length && (
              <Button size="small" type="link" style={{ fontSize: 12, padding: 0 }}
                onClick={() => { ackNotices(notices.map((n) => n.key)); setNotices([]) }}>全部已读</Button>
            )}
          </div>
        </Drawer>
      </Layout>
    </Layout>
  )
}
