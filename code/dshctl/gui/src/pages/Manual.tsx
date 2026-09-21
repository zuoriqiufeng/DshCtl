import { Typography, Space, Tag } from 'antd'
import { BookOutlined, RocketOutlined, AppstoreOutlined, NodeIndexOutlined, QuestionCircleOutlined, DeploymentUnitOutlined } from '@ant-design/icons'
import { PageHead, PageCard, Hint, StepBadge, CodeBlock } from '../api.tsx'

const { Text, Paragraph } = Typography

function Section({ icon, title, children, color = '#1677ff' }: { icon: React.ReactNode; title: string; children: React.ReactNode; color?: string }) {
  return (
    <PageCard size="small" title={<Space align="center"><span style={{ color, fontSize: 15 }}>{icon}</span><span>{title}</span></Space>}>
      {children}
    </PageCard>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0' }}>
      <StepBadge n={n} />
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 13, color: '#5b6575' }}>{children}</div>
      </div>
    </div>
  )
}

const PAGES: Array<[string, string]> = [
  ['概览', '体系健康一屏总览：实例/领域/依赖健康 + 每域 check 纤细表（点行进详情）'],
  ['实例登记', 'registry.yml 视图：端口分配、托管 unit、运行状态（点行开详情抽屉）'],
  ['领域管理', '左侧选领域 → 详情页：编排画布 / 概览 / check / diff / 清单编辑'],
  ['插件库', '插件目录（分类方卡）· 四种入库方式（方法卡）· 核心功能分组（R11 槽内可替换）'],
  ['升级对账', 'harness 更新后跑：全领域 roster 对账，给出"需要动的清单"'],
  ['新建领域', '向导五步创建 domain.yml（只写清单，实例骨架走 apply）'],
  ['使用手册', '本页'],
]

export default function ManualPage() {
  return (
    <div>
      <PageHead title="使用手册" desc="快速上手 · 页面速览 · DSH 体系 · 编排原理 · FAQ" icon={<BookOutlined />} iconColor="#722ed1" />
      <Space direction="vertical" style={{ width: '100%' }} size={14}>
        <Section icon={<RocketOutlined />} title="5 分钟上手" color="#52c41a">
          <Step n={1} title="看健康">打开「概览」——统计卡与依赖健康点告诉你体系是否正常；领域行的绿/红点阵是最近 7 次 check 趋势。</Step>
          <Step n={2} title="跑对账">「领域管理」→ 点领域 → check 页签自动运行。全绿即可放心 apply；有 error 按规则号展开看全文，底部有 R1-R12 图例。</Step>
          <Step n={3} title="改清单 / 起停">编辑页签表单化改 domain.yml（顶部锚点跳分区）；概览页签可启动/停止/重启实例（真控制 systemctl）或跑冒烟测试（临时实例，不碰现网）。</Step>
        </Section>

        <Section icon={<AppstoreOutlined />} title="页面速览">
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {PAGES.map(([p, d]) => (
              <div key={p} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                <Tag style={{ marginInlineEnd: 0, minWidth: 84, textAlign: 'center' }}>{p}</Tag>
                <Text type="secondary">{d}</Text>
              </div>
            ))}
          </Space>
          <div style={{ marginTop: 10, fontSize: 12, color: '#8c96a6' }}>
            界面只是薄壳——每个操作都能复现为等价 CLI 命令（各页右上角「等价命令」按钮）。完整命令手册见 doc/dshctl-manual.md。
          </div>
        </Section>

        <Section icon={<DeploymentUnitOutlined />} title="DSH 插件体系（插件为什么可以随处挂）" color="#eb2f96">
          <Space direction="vertical" size={8} style={{ width: '100%', fontSize: 13 }}>
            <div>
              <Text strong>DSH = everything-is-a-plugin。</Text>
              <Text type="secondary"> 会话、模型、工具、UI、存储……全部是插件，由 loader 按配置装配。</Text>
            </div>
            <CodeBlock>{`profile（实例配置层）
 └─ cordis.patch.yml：按 id 增删改插件行
     insert:
       - id: bkn-plugin
         name: /abs/path/index.ts   ← 绝对路径 = 本地插件直接挂
       - id: mcp-i2agent
         name: '@deepseek-ai/dsh-mcp-client'  ← 包名 = 上游插件
     disabled: true                 ← 按 id 裁剪（命中 core 清单 = R11 报错，功能槽除外）`}</CodeBlock>
            <div>
              <Text strong>两类插件</Text>：
              <Text type="secondary"> ① 上游插件（@deepseek-ai/* 包名，走 node_modules 解析）；
              ② 本地插件（绝对路径 TS 文件，loader 裸 import——这就是 dshctl 能把任意工作区插件挂进实例的原因）。</Text>
            </div>
            <div>
              <Text strong>config 是整段替换语义</Text>
              <Text type="secondary">：patch 里给某插件的 config 会整体替换默认值——漏字段 = 丢默认配置（smoke overlay 只改 port 也要整段复制就是这个原因）。</Text>
            </div>
          </Space>
        </Section>

        <Section icon={<NodeIndexOutlined />} title="dshctl 编排原理" color="#1677ff">
          <Space direction="vertical" size={8} style={{ width: '100%', fontSize: 13 }}>
            <div><Text strong>一份 domain.yml 描述一个领域</Text><Text type="secondary">（端口/能力包/护栏/插件/契约/依赖），check 校验 → apply 幂等生成实例骨架（profile patch + ops-app 裁剪层 + preset）。</Text></div>
            <CodeBlock>{`domain.yml ──check(R1-R12)──▶ apply ──▶ $DSH_HOME/profiles/<域>/   （manifest + patch）
                                   └──▶ $DSH_HOME/bundles/ops-app/ （纯增量裁剪层，按 id disable）
                                   └──▶ $DSH_HOME/presets/          （persona + 热路径）`}</CodeBlock>
            <div>
              <Text strong>能力包</Text><Text type="secondary">：core 恒隐含必裁（UI 面/编码 agent 面）；keep_tools 从 core 裁剪里"放回"工具；每个 id 归属唯一。core.yml 插件库页签里的 61 个核心功能是裁剪红线（R11）——核心功能不可缺，带「可替换」标记的属功能槽（同槽有活跃成员即可替换，自研扩展插件可入槽）。</Text>
            </div>
            <div>
              <Text strong>编排画布</Text><Text type="secondary">：四层推导（能力包→领域插件→domain-api→外部依赖）；拖拽插件排序 = 调整 patch insert 注册序；虚线 = 插件库 depends_on 声明。</Text>
            </div>
            <div>
              <Text strong>插件信任模型</Text><Text type="secondary">：路径收编 = trusted（自研）；zip/git 导入 = untrusted（引用时 R12 warn），核实源码后在卡片详情里点"标记信任"。</Text>
            </div>
          </Space>
        </Section>

        <Section icon={<QuestionCircleOutlined />} title="FAQ" color="#fa8c16">
          <Space direction="vertical" size={8} style={{ width: '100%', fontSize: 13 }}>
            <div><Text strong>页面白屏 / 改动没生效？</Text><Text type="secondary"> — Ctrl+Shift+R 强刷（浏览器缓存旧 JS）。</Text></div>
            <div><Text strong>git 导入失败？</Text><Text type="secondary"> — 本环境 github.com 不可达，走 zip 上传；或配代理后再试。</Text></div>
            <div><Text strong>start 报 "Unit not found"？</Text><Text type="secondary"> — systemd-run 瞬态 unit 被回收了：bash code/scripts/run-ops-trial.sh start 重装。</Text></div>
            <div><Text strong>密钥怎么配？</Text><Text type="secondary"> — 清单只写环境变量名（R8 强制），值放 $DSH_HOME/ops.env（权限 600）。</Text></div>
            <div><Text strong>GUI 安全边界？</Text><Text type="secondary"> — 无鉴权 + 具备写/起停能力：仅限可信内网；默认只绑 127.0.0.1，--host 0.0.0.0 需显式指定。</Text></div>
            <div><Text strong>完整文档在哪？</Text><Text type="secondary"> — doc/dshctl-user-manual.md（本页的完整版）· doc/dshctl-manual.md（CLI 参考）· doc/dshctl-exec-plan.md（实施记录）。</Text></div>
          </Space>
        </Section>
      </Space>
    </div>
  )
}
