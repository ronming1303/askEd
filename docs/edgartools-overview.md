# edgartools 主要方法速览

> 所有示例都是本次会话里实测跑通的，CIK/日期会随时间变化。

## 1. 初始化（必须）

SEC 要求请求带联系方式的 User-Agent：

```python
from edgar import set_identity
set_identity("Your Name your@email.com")
```

## 2. 公司查找 — `Company`

```python
from edgar import Company
company = Company("AAPL")        # 支持 ticker / CIK / 公司名
company.name                     # "Apple Inc."
company.cik                      # 320193
```

## 3. 拉取申报列表 — `get_filings`

```python
filings = company.get_filings()                 # 全部历史申报（按日期倒序）
filings = company.get_filings(form="10-K")      # 按表单类型过滤
filings = company.get_filings(form=["10-K", "10-Q"])

filings.head(5)                  # 取前 N 条（廉价，纯本地切片）
filings.filter(...)              # 进一步筛选
filings.latest()                 # 最新一条
```

每条 `Filing` 自带的**廉价字段**（来自批量 submissions JSON，不触发额外网络请求）：

```python
f.form                # "10-K"
f.filing_date         # 2025-10-31
f.accession_no        # "0000320193-25-000079"
f.primary_document    # "aapl-20250927.htm"
f.primary_doc_description
f.homepage_url        # 申报首页链接（字符串拼接，免费）
f.base_dir            # 文档所在目录前缀，可拼出直链
```

> ⚠️ 坑点：`f.period_of_report` 和 `f.document` 是**计算属性**，访问时会现抓 SGML/首页（每条一次额外请求）。批量遍历整段历史时千万别用，会撞上 SEC 10 req/秒的限速并被临时封 IP。

## 4. 解析为结构化对象 — `filing.obj()`

`.obj()` 会根据表单类型自动返回对应的解析对象：

```python
tenk    = company.get_filings(form="10-K")[0].obj()   # TenK
tenq    = company.get_filings(form="10-Q")[0].obj()   # TenQ
eightk  = company.get_filings(form="8-K")[0].obj()    # CurrentReport (8-K)
form4   = company.get_filings(form="4")[0].obj()      # Form4 (内部人交易)
thirteenf = filing.obj()                              # ThirteenF (机构持仓)
```

### 8-K 示例（实测 AAPL 2026-04-30 财报公告）

```python
eightk.items              # ['Item 2.02', 'Item 9.01'] — 触发的条款
eightk.sections           # 按 Item 拆分的正文章节，可 .text() 取可读文本
eightk.has_press_release  # True
eightk.press_releases     # 自动识别出的新闻稿附件
eightk.earnings           # EarningsRelease：从新闻稿里解析出的结构化财报
eightk.earnings.get_key_metrics()
# {'revenue': 111184000000.0, 'net_income': 29578000000.0,
#  'eps_basic': 2.02, 'eps_diluted': 2.01, 'period': '...', 'scale': MILLIONS}
eightk.earnings.income_statement / .balance_sheet / .cash_flow_statement
```

### Form 4 示例（内部人交易）

```python
form4.get_ownership_summary()   # 汇总 net_change / net_value / primary_activity
```

### 13F 示例（机构持仓）

```python
thirteenf.investments           # 按市值排序的持仓明细
```

## 5. 财务数据 — `Financials` / XBRL

```python
financials = company.get_financials()             # 年度（来自 10-K）
quarterly  = company.get_quarterly_financials()   # 季度（来自 10-Q）

xbrl = filing.xbrl()             # 低层 XBRL 对象：原始 facts/concepts/taxonomy
```

## 6. 全文检索 / 最新申报流

```python
from edgar import search_filings, get_current_filings

search_filings("share buyback", form="8-K")   # EDGAR 全文检索
get_current_filings()                          # 实时最新申报流
```

## 7. API 自助发现

每个对象都自带文档索引，方便临场查阅：

```python
company.docs                    # 完整 API 指南
company.docs.search("filings")  # 按关键词搜索用法
filing.docs.search("xbrl")
```

---

## 速记表

| 想做什么 | 用什么 |
|---|---|
| 按 ticker 找公司 | `Company(ticker)` |
| 拉某公司全部/某类申报 | `company.get_filings(form=...)` |
| 拿某条申报的结构化内容 | `filing.obj()` → `TenK`/`TenQ`/`EightK`/`Form4`/`ThirteenF` |
| 拆 10-K/10-Q/8-K 的章节正文 | `report.items` / `report.sections` |
| 拿财报关键指标 | `eightk.earnings.get_key_metrics()` |
| 拿年度/季度财务报表 | `company.get_financials()` |
| 拿内部人交易汇总 | `form4.get_ownership_summary()` |
| 拿机构持仓明细 | `thirteenf.investments` |
| 全文检索 | `search_filings(query, form=...)` |
