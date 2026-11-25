// 钥匙池的网页界面：列表 / 添加 / 停用 / 删除 / 改名 / 改并发 / 用量 / 复制钥匙
// 只由 pool.mjs 调用；页面和接口都只在 127.0.0.1 上提供。
import fs from "node:fs";

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>钥匙池</title>
<style>
  :root{
    --bg:#f6f5f2; --card:#fff; --ink:#1a1917; --muted:#8b8680; --line:#e9e7e3; --track:#edebe7;
    --ok:#0f8a63; --warm:#b8790f; --bad:#b23a3a; --dim:#c2bdb7;
    --plan:#6c63c4; --plan-soft:rgba(108,99,196,.45);
    --weight:#4f7fa8; --weight-on-dark:#8fb8d8; --plan-on-dark:#b9aaff;
    --hover:#fcfbf9; --chip:#f3f1ee; --chip-2:#f1eeea; --bad-soft:#fbebeb;
    --field:#fff; --field-focus:#cfcac3; --field-ring:#f2efeb; --slide-focus:#dedad4;
    --stripe1:#efedea; --stripe2:#f7f6f3;
    --shadow:rgba(26,25,23,.04); --shadow-2:rgba(26,25,23,.5);
    --invert-bg:#1a1917; --invert-fg:#fff;
    --cols:8px 40px minmax(0,1fr) 126px 92px 88px 54px; --gap:14px;
    --ui-scale:1.2;   /* 整页比例 */
  }
  :root[data-theme="dark"]{
    --bg:#191817; --card:#232120; --ink:#f2efec; --muted:#9a938c; --line:#332f2c; --track:#39352f;
    --ok:#3fbf8f; --warm:#d79b3a; --bad:#d97070; --dim:#655f59;
    --plan:#a79ef2; --plan-soft:rgba(167,158,242,.34);
    --weight:#7fb0d6;
    --hover:#2a2725; --chip:#322e2b; --chip-2:#322e2b; --bad-soft:#3a2726;
    --field:#1d1c1b; --field-focus:#4a453f; --field-ring:#2e2b28; --slide-focus:#4a453f;
    --stripe1:#2c2926; --stripe2:#232120;
    --shadow:rgba(0,0,0,.4); --shadow-2:rgba(0,0,0,.7);
    --invert-bg:#f2efec; --invert-fg:#1a1917;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.45 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    display:flex;justify-content:center;padding:46px 20px}
  /* 用 zoom 放大整页：宽度的上限也按同一比例折算，视觉上不会溢出窗口 */
  .wrap{width:100%;max-width:calc(880px / var(--ui-scale));zoom:var(--ui-scale)}

  .top{display:flex;align-items:baseline;justify-content:space-between;margin:0 4px 10px}
  h1{font-size:11.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;margin:0}
  .live{display:flex;align-items:center;gap:9px;color:var(--muted);
    font:11.5px ui-monospace,Consolas,monospace}
  .live .dot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
  /* 时间可双击改刷新间隔：悬停只亮起一块胶囊，不弹文字提示 */
  #stamp{cursor:pointer;border-radius:4px;padding:0 4px;transition:background .12s,box-shadow .12s}
  #stamp:hover{background:var(--chip);box-shadow:0 0 0 3px var(--chip)}
  #stamp[hidden]{display:none}
  .live .dot.off{background:var(--dim)}

  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;
    box-shadow:0 1px 2px var(--shadow),0 10px 30px -24px var(--shadow-2);overflow:hidden}

  .head,.row{display:grid;grid-template-columns:var(--cols);gap:var(--gap);align-items:center;padding:0 16px}
  .head{height:31px;border-bottom:1px solid var(--line);color:var(--muted);
    font:9.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em}
  .head .bars3 i{font-style:normal;text-align:center;letter-spacing:.06em}
  .row{min-height:46px;border-top:1px solid var(--line);transition:background .14s}
  #list .row:first-child{border-top:0}
  .row:hover{background:var(--hover)}
  .empty{padding:26px 16px;color:var(--muted);font-size:12px;text-align:center}

  .dot{width:7px;height:7px;border-radius:50%;background:var(--dim)}
  .dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(15,138,99,.1)}
  .dot.cool{background:var(--warm);box-shadow:0 0 0 3px rgba(184,121,15,.12)}
  .dot.bad{background:var(--bad);box-shadow:0 0 0 3px rgba(178,58,58,.12)}
  .dot.full{background:var(--warm);box-shadow:none}
  .dot.off{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dim)}

  .score{font:13.5px ui-monospace,Consolas,monospace;letter-spacing:-.02em;cursor:help;color:var(--muted)}
  .score.low{color:var(--ok)} .score.mid{color:var(--warm)} .score.high{color:var(--bad)}
  .score.none{color:var(--dim)}
  .score:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}

  .who{min-width:0;display:flex;flex-direction:column;gap:3px}
  .line{display:flex;align-items:baseline;gap:8px;min-width:0}
  .name{font-weight:560;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    cursor:text;border-radius:4px;transition:background .12s,box-shadow .12s}
  .name:hover{background:var(--chip);box-shadow:0 0 0 3px var(--chip)}
  .mask{font:10.5px ui-monospace,Consolas,monospace;color:var(--muted);white-space:nowrap;
    cursor:copy;border-radius:3px;transition:color .12s,background .12s}
  .mask:hover{color:var(--ink);background:var(--chip)}
  .mask.copied{color:var(--ok)}
  .rename,.maxedit{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:6px;
    padding:1px 6px;background:var(--field);color:var(--ink);min-width:0;width:100%}
  .slidewrap{display:flex;align-items:center;gap:7px;justify-content:flex-end}
  .rwrap{display:flex;align-items:center;gap:4px}
  .rwrap .unit{margin-left:0;color:var(--muted)}
  .rwrap[hidden]{display:none}
  .maxslide{-webkit-appearance:none;appearance:none;width:62px;height:14px;background:transparent;cursor:pointer}
  /* 去掉浏览器给聚焦元素画的黑框；滑杆本身就够显眼了 */
  .maxslide:focus,.maxslide:focus-visible{outline:0}
  /* 去掉黑框后给一点点聚焦提示：轨道稍微加深，键盘操作也看得见 */
  .maxslide:focus::-webkit-slider-runnable-track{background:var(--slide-focus)}
  .maxslide:focus::-moz-range-track{background:var(--slide-focus)}
  .maxslide::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:var(--track)}
  .maxslide::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;margin-top:-3.5px;
    border-radius:50%;background:var(--ink)}
  .maxslide::-moz-range-track{height:3px;border-radius:2px;background:var(--track)}
  .maxslide::-moz-range-thumb{width:10px;height:10px;border:0;border-radius:50%;background:var(--ink)}
  .slideval{font:11px ui-monospace,Consolas,monospace;color:var(--ink);min-width:14px;text-align:right}

  .bars3{display:grid;grid-template-columns:repeat(3,38px);gap:6px}
  /* 三层：底轨 → 预期（中间层）→ 实际（最上层，半透明，用正片叠底让重叠处颜色变深，
     这样即使实际盖住预期，也能同时看出两个位置 */
  .bar3{position:relative;height:4px;border-radius:2px;background:var(--track);color:var(--ok)}
  .bar3::after{content:"";position:absolute;left:0;right:0;top:-7px;bottom:-7px}
  /* margin:0 必须写：p 自带上下 1em 外边距，配合 top/bottom:0 会把高度压成 0，预期层就整条看不见 */
  .bar3 p{position:absolute;left:0;top:0;bottom:0;margin:0;border-radius:2px;background:var(--plan-soft)}
  .bar3 i{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:currentColor;opacity:.62;
    mix-blend-mode:multiply;transition:width .25s ease}
  .bar3.warm{color:var(--warm)}
  .bar3.hot{color:var(--bad)}
  .bar3.none{background:repeating-linear-gradient(135deg,var(--stripe1) 0 3px,var(--stripe2) 3px 6px)}
  .bar3.none p,.bar3.none i{display:none}

  .load{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:nowrap}
  .load .bar{width:32px;height:3px;border-radius:2px;background:var(--track);overflow:hidden}
  .load .bar i{display:block;height:100%;background:var(--muted);transition:width .3s}
  .load .bar i.hot{background:var(--warm)}
  .num{font:10.5px ui-monospace,Consolas,monospace;color:var(--muted);min-width:24px;text-align:right;white-space:nowrap}
  .num.cool{color:var(--warm)}
  .num .max{cursor:pointer;font-weight:500;color:var(--ink);opacity:.8}

  .use{display:flex;align-items:baseline;gap:8px;justify-content:flex-end;
    font:10.5px ui-monospace,Consolas,monospace;color:var(--muted);white-space:nowrap}
  .use b{font-weight:500;color:var(--ink);opacity:.72}
  .row.off .use,.row.off .who{opacity:.45}

  .acts{display:flex;gap:2px;justify-content:flex-end;opacity:0;pointer-events:none;transition:opacity .12s}
  .row:hover .acts,.row:focus-within .acts{opacity:1;pointer-events:auto}
  .acts button{width:22px;height:22px;border:0;background:transparent;color:var(--muted);
    border-radius:6px;cursor:pointer;font-size:13px;line-height:1}
  .acts button:hover{background:var(--chip-2);color:var(--ink)}
  .acts button.del:hover{background:var(--bad-soft);color:var(--bad)}
  @media (hover:none){.acts{opacity:1;pointer-events:auto}}

  .tune{display:flex;flex-direction:column;gap:8px;margin:0 0 10px;padding:10px 13px;
    background:var(--card);border:1px solid var(--line);border-radius:12px;
    font:10px ui-monospace,Consolas,monospace;color:var(--muted);letter-spacing:.06em}
  .tune[hidden]{display:none}
  /* 两行共用同一套列宽：预期与权重的 5h / 周 / 月 上下对齐；滑杆吃掉剩余宽度 */
  .tune .row2{display:grid;grid-template-columns:22px repeat(5,minmax(0,1fr));gap:0 9px;align-items:center}
  .tune .cap{font-size:9px;letter-spacing:.16em;color:var(--dim);white-space:nowrap}
  .tune label{display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;min-width:0}
  .tune .nm{flex:none;width:22px}   /* 名称占固定宽度，八根滑杆才会完全等长 */
  /* 滑杆：3px 实心轨道（颜色填到滑块位置），11px 圆点 */
  .tune label{color:var(--plan)}
  .tune label.w{color:var(--weight)}
  .tune label.w input[type=range]{color:var(--weight)}
  .tune input[type=range]{flex:1 1 auto;min-width:26px;width:auto;height:14px;cursor:pointer;
    -webkit-appearance:none;appearance:none;background:transparent;--fill:0%;
    color:var(--plan)}   /* 表单控件不自继承颜色，要显式给，否则滑块是黑的 */
  .tune input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;
    background:linear-gradient(to right,currentColor 0 var(--fill),var(--track) var(--fill) 100%)}
  .tune input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:-4px;
    border-radius:50%;background:currentColor}
  .tune input[type=range]::-moz-range-track{height:3px;border-radius:2px;
    background:linear-gradient(to right,currentColor 0 var(--fill),var(--track) var(--fill) 100%)}
  .tune input[type=range]::-moz-range-thumb{width:11px;height:11px;border:0;border-radius:50%;background:currentColor}
  /* 数值+单位放进同一个等宽槽：所有滑杆长度一致，数字紧贴滑杆 */
  .tune .ro{flex:none;width:34px;display:flex;align-items:baseline;gap:2px}
  .tune .val{flex:none;font-weight:600;color:var(--plan);letter-spacing:0;font-variant-numeric:tabular-nums}
  .tune .unit{flex:none;font-style:normal;color:var(--plan);opacity:.8}
  .tune label.w input[type=range]{accent-color:var(--weight)}
  .tune label.w .val{color:var(--weight)}
  .tune label.w .unit{color:var(--weight)}
  /* 组间竖线画在列间距里，不占宽度，滑杆长度不受影响 */
  .tune .cell.grp{position:relative}
  .tune .cell.grp::before{content:"";position:absolute;left:-5px;top:50%;width:1px;height:12px;
    margin-top:-6px;background:var(--line)}
  .icon{width:22px;height:22px;border:0;border-radius:6px;background:transparent;cursor:pointer;
    display:flex;align-items:center;justify-content:center;color:var(--muted);flex:none;padding:0}
  .icon:hover{background:var(--chip-2);color:var(--ink)}
  .ico-sun{display:none}
  :root[data-theme="dark"] .ico-moon{display:none}
  :root[data-theme="dark"] .ico-sun{display:block}
  .gear{width:22px;height:22px;border:0;border-radius:6px;background:transparent;cursor:pointer;
    position:relative;margin-left:2px;flex:none}
  .gear:hover{background:var(--chip-2)}
  .gear::before{content:"";position:absolute;left:5px;right:5px;top:6px;height:1.5px;border-radius:1px;
    background:var(--muted);box-shadow:0 5px 0 var(--muted),0 10px 0 var(--muted)}
  .gear.on::before{background:var(--plan);box-shadow:0 5px 0 var(--plan),0 10px 0 var(--plan)}

  form{display:grid;grid-template-columns:1fr 1.6fr 52px 30px;gap:9px;padding:10px 16px;
    border-top:1px solid var(--line)}
  form input{height:28px;border:1px solid var(--line);border-radius:7px;background:var(--field);color:var(--ink);padding:0 9px;
    font-size:12px;min-width:0;font-family:inherit}
  form input:focus{outline:none;border-color:var(--field-focus);box-shadow:0 0 0 3px var(--field-ring)}
  form button{height:28px;border:1px solid var(--ink);border-radius:7px;background:var(--ink);color:var(--card);
    font-size:13px;cursor:pointer}
  form button:disabled{opacity:.4}

  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(6px);
    background:var(--invert-bg);color:var(--invert-fg);padding:7px 13px;border-radius:8px;
    font-size:calc(12px * var(--ui-scale));
    opacity:0;transition:opacity .16s,transform .16s;pointer-events:none}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

  .pan{position:fixed;z-index:12;zoom:var(--ui-scale);background:#232120;color:#f7f6f4;
    border-radius:10px;padding:10px 13px;font:11px/1.7 ui-monospace,Consolas,monospace;
    border:1px solid rgba(255,255,255,.07);
    box-shadow:0 10px 30px rgba(0,0,0,.22);opacity:0;transform:translateY(4px);
    transition:opacity .12s,transform .12s;pointer-events:none}
  .pan.show{opacity:1;transform:translateY(0);pointer-events:auto}
  /* 八列对齐：名称 | 已用 | − | 预期 | = | 差值 | 权重 | 代价 */
  .pan .w,.pan .s{display:grid;gap:0 5px;align-items:baseline;
    grid-template-columns:24px 32px 9px 32px 9px 40px 34px 44px}
  .pan .w i{font-style:normal;color:#a9a29b;white-space:nowrap}
  .pan .w b{font-weight:500}
  .pan .w .u{text-align:right;font-weight:600}
  .pan .w .u.ok{color:#5ec9a0}
  .pan .w .u.warm{color:#e2a750}
  .pan .w .u.hot{color:#e07b7b}
  .pan .w .op{color:#6f6a64;text-align:center}
  .pan .w .plan{font-style:normal;color:var(--plan-on-dark);text-align:right}
  .pan .w .d{text-align:right}
  .pan .w .wt{color:var(--weight-on-dark);text-align:right}
  .pan .w .v{text-align:right;font-weight:600}
  .pan .s{border-top:1px solid #3a3733;margin-top:7px;padding-top:6px;color:#a9a29b}
  .pan .s span{grid-column:1 / 7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pan .s b{grid-column:8;text-align:right;font-weight:600;color:#f7f6f4}

  /* 键盘可达：凡是能点的，都要看得见焦点 */
  :where(button,[tabindex],input):focus-visible{outline:2px solid var(--plan);outline-offset:2px}
  .row .score:focus-visible,.row .name:focus-visible,.row .mask:focus-visible{outline-offset:3px;border-radius:4px}
  /* 按下回弹 4%，指尖才有反馈；禁用时不弹 */
  .acts button,.icon,.gear,form button{transition:background .14s,color .14s,transform .14s cubic-bezier(.2,0,0,1)}
  .acts button:active,.icon:active,.gear:active,form button:active{transform:scale(.96)}
  .acts button:disabled,form button:disabled{transform:none}
  /* 小按钮的落点扩大到 28px，视觉尺寸不变 */
  .acts button{position:relative}
  .acts button::after{content:"";position:absolute;inset:-3px}
  /* 细条跟着数据平滑移动，每 5 秒刷新不再硬跳 */
  .bar3 p,.bar3 i,.load .bar i{transition:width .45s cubic-bezier(.2,0,0,1)}
  .row.new{animation:rowIn .26s cubic-bezier(.2,0,0,1) backwards}
  @keyframes rowIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  /* 配置条很少打开，值得有一次轻微的展开 */
  .tune:not([hidden]){animation:tuneIn .22s cubic-bezier(.2,0,0,1)}
  .tune:not([hidden]) .row2:nth-child(2){animation:tuneIn .22s .04s backwards cubic-bezier(.2,0,0,1)}
  @keyframes tuneIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  /* 首次加载先给骨架，比一个省略号安静 */
  .skel{height:46px;border-top:1px solid var(--line);
    background:linear-gradient(90deg,transparent 0,rgba(127,127,127,.10) 50%,transparent 100%);
    background-size:220% 100%;animation:skel 1.2s linear infinite}
  .skel:first-child{border-top:0}
  @keyframes skel{from{background-position:120% 0}to{background-position:-120% 0}}
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;
      transition-duration:.01ms !important;scroll-behavior:auto !important}
  }
  @media (hover:none){
    .acts{opacity:1;pointer-events:auto}
    .row:hover{background:transparent}
  }
  @media (max-width:700px){
    body{padding:26px 12px}
    :root{--cols:7px 32px minmax(0,1fr) 118px 54px 44px;--gap:10px}
    .head{display:none}
    .row{min-height:54px}
    .use{display:none}
    form{grid-template-columns:1fr 1.4fr 48px 28px;padding:9px 12px}
  }
</style>
<script>
try {
  var t = localStorage.getItem("kp-theme");
  var sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = t || (sysDark ? "dark" : "light");
} catch (e) {}
</script>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>钥匙池</h1>
    <div class="live"><span class="dot" id="dot"></span><span id="stamp" tabindex="0" title="双击或回车改刷新间隔"></span>
      <span class="rwrap" id="rslide" hidden><input class="maxslide" id="rrange" type="range" min="1" max="10" step="1"><b class="slideval" id="rval">5</b><span class="unit">s</span></span>
      <button class="icon" id="themeBtn" title="切换日间 / 夜间">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path class="ico-moon" d="M10.6 2.2A5.6 5.6 0 1 0 13.8 9a4.4 4.4 0 0 1-3.2-6.8z" fill="currentColor"/>
          <g class="ico-sun" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <circle cx="8" cy="8" r="2.9"/>
            <path d="M8 .9v1.6M8 13.5v1.6M.9 8h1.6M13.5 8h1.6M2.9 2.9l1.15 1.15M11.95 11.95L13.1 13.1M13.1 2.9l-1.15 1.15M4.05 11.95L2.9 13.1"/>
          </g>
        </svg>
      </button>
      <button class="gear" id="tuneBtn" title="预期用量与权重"></button></div>
  </div>

  <div class="tune" id="tune" hidden>
    <div class="row2">
      <span class="cap">预期</span>
      <label class="cell"><span class="nm">5h</span><input type="range" data-k="rolling" min="5" max="100" step="1"><span class="ro"><b class="val">5</b><em class="unit">h</em></span></label>
      <label class="cell"><span class="nm">周</span><input type="range" data-k="weekly" min="5" max="100" step="1"><span class="ro"><b class="val">5.6</b><em class="unit">d</em></span></label>
      <label class="cell"><span class="nm">月</span><input type="range" data-k="monthly" min="5" max="100" step="1"><span class="ro"><b class="val">18</b><em class="unit">d</em></span></label>
    </div>
    <div class="row2">
      <span class="cap">权重</span>
      <label class="cell w"><span class="nm">5h</span><input type="range" data-sh="rolling" min="0" max="2" step="0.1"><span class="ro"><b class="val">0.2</b><em class="unit"></em></span></label>
      <label class="cell w"><span class="nm">周</span><input type="range" data-sh="weekly" min="0" max="2" step="0.1"><span class="ro"><b class="val">0.5</b><em class="unit"></em></span></label>
      <label class="cell w"><span class="nm">月</span><input type="range" data-sh="monthly" min="0" max="2" step="0.1"><span class="ro"><b class="val">1.0</b><em class="unit"></em></span></label>
      <label class="cell w grp"><span class="nm">并发</span><input type="range" data-w="loadPoints" min="0" max="2" step="0.1"><span class="ro"><b class="val">0.3</b><em class="unit"></em></span></label>
      <label class="cell w"><span class="nm">失败</span><input type="range" data-w="failPoints" min="0" max="5" step="0.5"><span class="ro"><b class="val">1.0</b><em class="unit"></em></span></label>
    </div>
  </div>

  <div class="card">
    <div class="head">
      <span></span><span>代价</span><span>钥匙</span>
      <span class="bars3"><i>5h</i><i>周</i><i>月</i></span>
      <span style="text-align:right">并发</span><span style="text-align:right">今日</span><span></span>
    </div>
    <div id="list"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>

    <form id="add" autocomplete="off">
      <input name="name" placeholder="名字" required maxlength="40" aria-label="钥匙名字">
      <input name="key" placeholder="钥匙" required spellcheck="false" aria-label="钥匙内容">
      <input name="maxConcurrent" type="number" min="0" max="64" value="10" placeholder="并发" title="同时请求上限">
      <button type="submit" title="添加">+</button>
    </form>
  </div>
</div>
<div class="toast" id="toast"></div>
<div class="pan" id="pan"></div>

<script>
const $ = (s, r = document) => r.querySelector(s);

/* 整页比例固定为 1.2，写在 CSS 的 --ui-scale 里 */
const uiScale = 1.2;

$("#themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("kp-theme", next); } catch {}
});
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1600); };
let editing = false;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const safeEnc = (s) => { try { return encodeURIComponent(s); } catch { return ""; } };
const fmt = (n) => !n ? "0" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n);
const money = (c) => !c ? "$0" : c >= 0.01 ? "$" + c.toFixed(2) : c >= 0.001 ? "$" + c.toFixed(3) : "$" + c.toFixed(5);

function stateOf(k, blocked) {
  if (k.enabled === false) return "off";
  if (k.cooldownSeconds > 0) return "cool";
  if (k.lastStatus === 401 || k.lastStatus === 403) return "bad";
  if (blocked) return "full";
  return "ok";
}

const LABEL = { rolling: "5h", weekly: "周", monthly: "月" };

const usableOf = (k) => {
  if (k.enabled === false) return false;
  if (k.ready === false || (k.cooldownSeconds || 0) > 0) return false;
  const cap = k.maxConcurrent || 0;
  if (cap && (k.active || 0) >= cap) return false;
  const r = k.breakdown && k.breakdown.R;
  return !(r != null && r <= 0);
};
const expiryOf = (k) => {
  let best = Infinity;
  for (const w of (k.breakdown && k.breakdown.windows) || []) {
    if (w.missing || !(w.resetAtMs > 0) || w.percent >= 100) continue;
    if (w.resetAtMs < best) best = w.resetAtMs;
  }
  return best;
};

/* 行不重建，只改文字和宽度：刷新时不再闪一下，悬停和焦点也不会丢 */
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const rowMap = new Map();
let painted = false;

/* 行内编辑会把某个格子换掉：把这一行从缓存里摘掉，下次刷新整行重建，
   旧节点由 render 末尾的清扫统一移除（立刻删会让下面的行先跳一下） */
function dropRow(name) {
  rowMap.delete(name);
}

function blankRow() {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML =
    '<span class="dot"></span>' +
    '<span class="score" tabindex="0" role="button" aria-label="看这把钥匙的代价明细"></span>' +
    '<div class="who"><div class="line"><span class="name" tabindex="0"></span>' +
      '<span class="mask" tabindex="0"></span></div></div>' +
    '<span class="bars3">' +
      '<span class="bar3"><p></p><i></i></span>' +
      '<span class="bar3"><p></p><i></i></span>' +
      '<span class="bar3"><p></p><i></i></span>' +
    '</span>' +
    '<div class="load"><span class="bar"><i></i></span><span class="num"><span class="act">0</span>/' +
      '<b class="max" tabindex="0"></b></span></div>' +
    '<div class="use"><span class="up"></span><b class="cost"></b></div>' +
    '<div class="acts"><button data-act="toggle"></button>' +
      '<button class="del" data-act="del" title="删除">×</button></div>';
  const q = (sel) => el.querySelector(sel);
  return {
    el,
    dot: q(".dot"), score: q(".score"), name: q(".name"), mask: q(".mask"),
    bars: Array.from(el.querySelectorAll(".bar3")).map((w) => ({
      wrap: w, band: w.querySelector("p"), fill: w.querySelector("i"),
    })),
    loadBar: q(".load .bar i"), act: q(".act"), max: q(".max"),
    up: q(".up"), cost: q(".cost"), toggle: q('button[data-act="toggle"]'),
  };
}

function updateRow(r, k) {
  const bd = k.breakdown || {};
  const blocked = k.enabled !== false && bd.R != null && bd.R <= 0;
  const st = stateOf(k, blocked);
  const name = String(k.name);
  r.el.className = "row" + (st === "off" ? " off" : "");
  r.el.dataset.name = safeEnc(name);
  r.dot.className = "dot " + st;

  if (r.name.textContent !== name) r.name.textContent = name;
  const mask = k.masked || "";
  if (r.mask.textContent !== mask) r.mask.textContent = mask;
  r.mask.dataset.key = k.key || "";
  r.name.title = "双击或回车改名";
  r.mask.title = "点一下复制钥匙";

  (bd.windows || []).forEach((w, i) => {
    const b = r.bars[i];
    if (!b) return;
    const tag = LABEL[w.name] || w.name;
    if (w.missing) {
      b.wrap.className = "bar3 none";
      b.wrap.title = tag + " 暂无数据";
      return;
    }
    const used = Math.max(0, Math.min(100, w.percent));
    const plan = w.proRata == null ? null : Math.max(0, Math.min(100, w.proRata));
    const kind = used >= 92 ? "hot" : plan != null && used > plan + 3 ? "warm" : "";
    b.wrap.className = ("bar3 " + kind).trim();
    b.wrap.title = tag + " 已用 " + Math.round(used) + "% · 预期 " + (plan == null ? "—" : Math.round(plan) + "%");
    b.band.style.display = plan == null ? "none" : "";
    if (plan != null) b.band.style.width = plan + "%";
    b.fill.style.width = used + "%";
  });

  const max = k.maxConcurrent || 0;
  const pct = max ? Math.min(100, Math.round((k.active / max) * 100)) : 0;
  r.loadBar.style.width = pct + "%";
  r.loadBar.className = max && k.active / max >= 0.8 ? "hot" : "";
  r.act.textContent = k.active || 0;
  const mx = String(max || "∞");
  if (r.max.textContent !== mx) r.max.textContent = mx;
  r.max.dataset.max = max;
  r.max.title = "双击或回车改同时请求上限";

  const u = k.usage || {};
  r.up.textContent = "↑" + fmt(u.input);
  r.cost.textContent = money(u.cost);

  const sc = bd.total;
  const lvl = sc == null ? "none" : sc <= 5 ? "low" : sc <= 20 ? "mid" : "high";
  const txt = sc == null || !Number.isFinite(sc) ? "—" : sc.toFixed(1);
  r.score.className = "score " + lvl;
  if (r.score.textContent !== txt) r.score.textContent = txt;
  r.score.dataset.break = encodeURIComponent(JSON.stringify({
    total: bd.total,
    windows: bd.windows || [],
    load: [bd.active || 0, bd.betaLoad || 0.3, Math.round((bd.load || 0) * 100) / 100],
    fail: [bd.fails || 0, bd.betaFail || 1, Math.round((bd.fail || 0) * 100) / 100],
    R: bd.R,
    st: [k.ok, k.rateLimited, k.authErrors],
    u: [u.input, u.output, u.cost],
  }));

  const off = k.enabled === false;
  r.toggle.dataset.on = off ? "1" : "0";
  r.toggle.title = off ? "启用" : "停用";
  r.toggle.textContent = off ? "▶" : "⏸";
}

function render(state) {
  $("#dot").className = "dot ok";
  $("#stamp").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  const list = $("#list");
  const names = new Set(state.keys.map((k) => k.name));
  for (const [n, r] of rowMap) {
    if (!names.has(n)) { r.el.remove(); rowMap.delete(n); }
  }
  if (!state.keys.length) {
    rowMap.clear();
    list.innerHTML = '<div class="empty">还没有钥匙<br><span>在下面填名字和钥匙，点 +</span></div>';
    painted = true;
    return;
  }
  list.querySelectorAll(".skel,.empty").forEach((n) => n.remove());

  const keys = state.keys.slice().sort((a, b) => {
    const ua = usableOf(a) ? 0 : 1;
    const ub = usableOf(b) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    const ta = a.score == null ? Infinity : a.score;
    const tb = b.score == null ? Infinity : b.score;
    if (Math.abs(ta - tb) > 0.3) return ta - tb;
    const fa = a.fails || 0;
    const fb = b.fails || 0;
    if (fa !== fb) return fa - fb;
    const ea = expiryOf(a);
    const eb = expiryOf(b);
    if (ea !== eb) return ea < eb ? -1 : 1;
    const aa = a.active || 0;
    const ab = b.active || 0;
    if (aa !== ab) return aa - ab;
    return String(a.name).localeCompare(String(b.name));
  });

  // 先量旧位置，再排新顺序，然后让挪了地方的行滑过去
  const before = new Map();
  if (painted && !reducedMotion) {
    for (const k of keys) {
      const r = rowMap.get(k.name);
      if (r && r.el.parentNode === list) before.set(r.el, r.el.getBoundingClientRect().top);
    }
  }

  const order = [];
  for (const k of keys) {
    let r = rowMap.get(k.name);
    const fresh = !r;
    if (!r) { r = blankRow(); rowMap.set(k.name, r); }
    updateRow(r, k);
    order.push(r.el);
    if (fresh) {
      r.el.classList.add("new");
      r.el.addEventListener("animationend", () => r.el.classList.remove("new"), { once: true });
    }
  }

  // 只挪真正换了位置的行：整段重排会把键盘焦点踢掉（每 5 秒踢一次谁都受不了）
  let cursor = list.firstElementChild;
  for (const el of order) {
    if (el === cursor) { cursor = cursor.nextElementSibling; continue; }
    list.insertBefore(el, cursor);
  }

  // 清扫：编辑过程中被换掉、已不在缓存里的行（否则会和重建的行一起留在页面上）
  const live = new Set();
  for (const r of rowMap.values()) live.add(r.el);
  for (const el of Array.from(list.querySelectorAll(".row"))) {
    if (!live.has(el)) el.remove();
  }

  if (!reducedMotion) {
    for (const [el, top] of before) {
      const d = top - el.getBoundingClientRect().top;
      if (Math.abs(d) > 1) {
        el.animate(
          [{ transform: "translateY(" + d / uiScale + "px)" }, { transform: "none" }],
          { duration: 260, easing: "cubic-bezier(.2,0,0,1)" },
        );
      }
    }
  }
  painted = true;

  if (panPinned && panFor) {
    if (panFor.isConnected) showPan(panFor, true);
    else hidePan();   // 这一行被重建了，面板跟着收起，别浮在空气上
  }
  syncTune(state.targets, state.weights, state.windowWeights);
}

const TARGET_DEFAULTS = { rolling: 1, weekly: 0.8, monthly: 0.6 };
// 三档的标称窗口长度：5 小时、7 天、30 天。滑杆存的是百分比，界面显示换算后的真实时间。
const TARGET_SPAN = { rolling: { unit: "h", span: 5 }, weekly: { unit: "d", span: 7 }, monthly: { unit: "d", span: 30 } };
function targetParts(key, percent) {
  const cfg = TARGET_SPAN[key] || TARGET_SPAN.monthly;
  const v = (cfg.span * Number(percent)) / 100;
  return { num: Number.isInteger(v) ? String(v) : v.toFixed(1), unit: cfg.unit };
}
const WEIGHT_DEFAULTS = { loadPoints: 0.3, failPoints: 1 };
const SHARE_DEFAULTS = { rolling: 0.2, weekly: 0.5, monthly: 1 };

function setFill(inp) {
  const min = Number(inp.min || 0);
  const max = Number(inp.max || 100);
  const v = Number(inp.value || 0);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  inp.style.setProperty("--fill", Math.max(0, Math.min(100, pct)).toFixed(2) + "%");
}

function fmtW(v) {
  const n = Number(v);
  return Number.isFinite(n) ? (n % 1 === 0 ? n.toFixed(1) : String(n)) : "—";
}

function syncTune(targets, weights, shares) {
  const box = $("#tune");
  if (!box) return;
  if (box.contains(document.activeElement)) return; // 正在拖的时候别把它拽回去
  box.querySelectorAll("input").forEach((inp) => {
    const tag = inp.parentElement.querySelector("b");
    if (inp.dataset.k) {
      const raw = targets && targets[inp.dataset.k] != null ? Number(targets[inp.dataset.k]) : TARGET_DEFAULTS[inp.dataset.k];
      const v = Math.round(raw * 100);
      inp.value = v;
      const parts = targetParts(inp.dataset.k, v);
      tag.textContent = parts.num;
      const unit = inp.parentElement.querySelector(".unit");
      if (unit) unit.textContent = parts.unit;
    } else if (inp.dataset.sh) {
      const raw = shares && shares[inp.dataset.sh] != null ? Number(shares[inp.dataset.sh]) : SHARE_DEFAULTS[inp.dataset.sh];
      inp.value = raw;
      tag.textContent = fmtW(raw);
    } else if (inp.dataset.w) {
      const raw = weights && weights[inp.dataset.w] != null ? Number(weights[inp.dataset.w]) : WEIGHT_DEFAULTS[inp.dataset.w];
      inp.value = raw;
      tag.textContent = fmtW(raw);
    }
    // 所有滑杆都要画实心，别只在某个分支里调——之前权重的三档因此没有填充
    setFill(inp);
  });
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}

async function refresh() {
  if (editing) return;
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    render(await r.json());
  } catch {
    $("#dot").className = "dot off";
    $("#stamp").textContent = "—";
  }
}

function inlineInput(className, value, extra = {}) {
  const input = document.createElement("input");
  input.className = className;
  input.value = value;
  Object.assign(input, extra);
  return input;
}

function startRename(el) {
  if (editing) return;
  editing = true;
  const row = el.closest(".row");
  const old = decodeURIComponent(row.dataset.name);
  const input = inlineInput("rename", old, { maxLength: 40 });
  el.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    editing = false;
    dropRow(old);   // 行里的名字节点已被输入框替换，交给下一次刷新重建
    const val = String(input.value || "").trim();
    if (!commit || !val || val === old) { await refresh(); return; }
    try { await post("/api/keys/rename", { from: old, to: val }); } catch (err) { toast(err.message); }
    await refresh();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

const CONC_MIN = 2;
const CONC_MAX = 15;

function startMaxEdit(el) {
  if (editing) return;
  editing = true;
  const row = el.closest(".row");
  const name = decodeURIComponent(row.dataset.name);
  const before = Number(el.dataset.max || 0);
  const start = Math.min(CONC_MAX, Math.max(CONC_MIN, before || CONC_MIN));
  const wrap = document.createElement("span");
  wrap.className = "slidewrap";
  const slide = inlineInput("maxslide", String(start), { type: "range", min: CONC_MIN, max: CONC_MAX, step: 1 });
  const valTag = document.createElement("b");
  valTag.className = "slideval";
  valTag.textContent = start;
  wrap.append(slide, valTag);
  slide.addEventListener("input", () => { valTag.textContent = slide.value; });
  // 整个“已用/上限”一起换成滑杆：只换数字会撑破列宽
  const cell = el.closest(".load") || el.closest(".num") || el;
  cell.replaceWith(wrap);
  slide.focus();
  let moved = false;
  slide.addEventListener("input", () => { moved = true; });
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    editing = false;
    dropRow(name);   // 整格已换成滑杆，刷新时重建这一行
    const val = Math.min(CONC_MAX, Math.max(CONC_MIN, Number(slide.value || start)));
    if (commit && moved && val !== before) {
      try { await post("/api/keys/update", { name, maxConcurrent: val }); } catch (err) { toast(err.message); }
    }
    await refresh();
  };
  slide.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  });
  // 点别处（失焦）就算确认
  slide.addEventListener("blur", () => finish(true));
}

$("#list").addEventListener("dblclick", (e) => {
  const nameEl = e.target.closest(".name");
  if (nameEl) return startRename(nameEl);
  const maxEl = e.target.closest(".max");
  if (maxEl) startMaxEdit(maxEl);
});

$("#list").addEventListener("click", async (e) => {
  const scoreEl = e.target.closest(".score");
  if (scoreEl && scoreEl.dataset.break) {
    if (panPinned && panFor === scoreEl) hidePan(); else showPan(scoreEl, true);
    return;
  }
  if (panPinned && !e.target.closest(".pan")) hidePan();
  const mask = e.target.closest(".mask");
  if (mask) {
    const key = mask.dataset.key;
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = key;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    mask.classList.add("copied");
    setTimeout(() => mask.classList.remove("copied"), 1200);
    toast("已复制");
    return;
  }
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const name = decodeURIComponent(btn.closest(".row").dataset.name);
  btn.disabled = true;
  try {
    if (btn.dataset.act === "toggle") {
      await post("/api/keys/update", { name, enabled: btn.dataset.on === "1" });
    } else {
      if (!confirm("删除「" + name + "」？")) return;
      await post("/api/keys/delete", { name });
    }
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

const pan = $("#pan");
let panPinned = false;
let panFor = null;
function panHtml(p) {
  const sign1 = (x) => (x == null || !Number.isFinite(x) ? "—" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1));
  const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : Math.round(v) + "%");
  const wt = (v) => (v == null ? "—" : "× " + (Number(v) % 1 === 0 ? Number(v).toFixed(1) : String(v)));
  // 和细条同一套判色：≥92% 红；比预期高 3 个点以上琥珀；其余绿
  const levelOf = (used, plan) => (used >= 92 ? "hot" : plan != null && used > plan + 3 ? "warm" : "ok");
  const row = (tag, usedCell, expected, diff, weight, contrib) =>
    '<div class="w"><i>' + tag + "</i>" + usedCell +
    '<b class="op">' + (expected == null ? "" : "−") + "</b>" +
    '<em class="plan">' + (expected == null ? "" : expected) + "</em>" +
    '<b class="op">' + (diff == null ? "" : "=") + "</b>" +
    '<b class="d">' + (diff == null ? "" : diff) + "</b>" +
    '<b class="wt">' + weight + "</b>" +
    '<b class="v">' + contrib + "</b></div>";

  const rows = (p.windows || []).map((w) => {
    const tag = LABEL[w.name] || w.name;
    if (w.missing) return row(tag, '<b class="u">—</b>', null, null, "—", "—");
    const used = Math.round(w.percent);
    const plan = w.proRata == null ? null : Math.round(w.proRata);
    const diff = plan == null ? null : used - plan;
    const usedCell = '<b class="u ' + levelOf(used, plan) + '">' + pct(used) + "</b>";
    const diffText = diff == null ? null : (diff > 0 ? "+" : diff < 0 ? "−" : "") + Math.abs(diff) + "%";
    return row(tag, usedCell, plan == null ? null : pct(plan), diffText, wt(w.share), sign1(w.contrib));
  }).join("");

  const tail = row("并发", '<b class="u">' + p.load[0] + "</b>", null, null, wt(p.load[1]), sign1(p.load[2])) +
    row("失败", '<b class="u">' + p.fail[0] + "</b>", null, null, wt(p.fail[1]), sign1(p.fail[2]));

  const foot = '<div class="s"><span>↑' + fmt(p.u[0]) + " ↓" + fmt(p.u[1]) + " " + money(p.u[2]) +
    "</span><b>" + sign1(p.total) + "</b></div>";
  return rows + tail + foot;
}

/* 悬停看明细，点一下（或键盘回车）钉住，Esc 收起 */
function showPan(el, pin) {
  let p;
  try { p = JSON.parse(decodeURIComponent(el.dataset.break)); } catch { return; }
  pan.innerHTML = panHtml(p);
  pan.classList.add("show");
  if (panFor && panFor !== el) panFor.setAttribute("aria-expanded", "false");
  panPinned = !!pin;
  panFor = el;
  el.setAttribute("aria-expanded", pin ? "true" : "false");
  const r = el.getBoundingClientRect();
  // 面板自己也带了 zoom，所以要先把视觉坐标换算回它自己的坐标系
  const s = uiScale || 1;
  const pw = pan.offsetWidth * s;
  const ph = pan.offsetHeight * s;
  const vx = Math.max(8, Math.min(r.left - 8, innerWidth - pw - 8));
  let vy = r.bottom + 8;
  if (vy + ph > innerHeight - 8) vy = Math.max(8, r.top - ph - 8);
  pan.style.left = vx / s + "px";
  pan.style.top = vy / s + "px";
}
function hidePan() {
  if (panFor) panFor.setAttribute("aria-expanded", "false");
  panPinned = false;
  panFor = null;
  pan.classList.remove("show");
}

$("#list").addEventListener("mouseover", (e) => {
  if (panPinned) return;
  const el = e.target.closest(".score");
  if (!el || !el.dataset.break) return;
  showPan(el, false);
});
$("#list").addEventListener("mouseout", (e) => {
  if (panPinned) return;
  const el = e.target.closest(".score");
  if (el && panFor === el) hidePan();
});

/* 键盘也要能进得去：明细可以回车钉住，名字和上限可以回车进编辑，钥匙可以回车复制 */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panPinned) { hidePan(); e.preventDefault(); }
});
$("#list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target;
  if (el.classList.contains("score")) {
    e.preventDefault();
    if (panPinned && panFor === el) hidePan(); else showPan(el, true);
  } else if (el.classList.contains("name")) {
    e.preventDefault();
    startRename(el);
  } else if (el.classList.contains("max")) {
    e.preventDefault();
    startMaxEdit(el);
  } else if (el.classList.contains("mask")) {
    e.preventDefault();
    el.click();
  }
});

$("#tuneBtn").addEventListener("click", () => {
  const t = $("#tune");
  t.hidden = !t.hidden;
  $("#tuneBtn").classList.toggle("on", !t.hidden);
});

$("#tune").addEventListener("input", (e) => {
  const inp = e.target.closest("input[type=range]");
  if (!inp) return;
  const tag = inp.parentElement.querySelector("b");
  if (inp.dataset.k) {
    const parts = targetParts(inp.dataset.k, inp.value);
    tag.textContent = parts.num;
    const unit = inp.parentElement.querySelector(".unit");
    if (unit) unit.textContent = parts.unit;
  } else {
    tag.textContent = fmtW(inp.value);
  }
  setFill(inp);
});
$("#tune").addEventListener("change", async (e) => {
  const inp = e.target.closest("input[type=range]");
  if (!inp) return;
  const targets = {};
  const weights = {};
  const windowWeights = {};
  $("#tune").querySelectorAll("input").forEach((i) => {
    if (i.dataset.k) targets[i.dataset.k] = Number(i.value);
    else if (i.dataset.sh) windowWeights[i.dataset.sh] = Number(i.value);
    else if (i.dataset.w) weights[i.dataset.w] = Number(i.value);
  });
  try {
    await post("/api/routing", { targetShare: targets, weights, windowWeights });
  } catch (err) {
    toast(err.message);
  }
  await refresh();
});

$("#add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    await post("/api/keys", {
      name: String(f.get("name") || "").trim(),
      key: String(f.get("key") || "").trim(),
      maxConcurrent: Number(f.get("maxConcurrent") || 0),
    });
    e.target.reset();
    e.target.querySelector('[name="maxConcurrent"]').value = "10";
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* 刷新间隔：默认 5 秒，双击右上角时间改成 1~10 秒，点空白处生效，存在本机 */
let refreshMs = Number(localStorage.getItem("kp-refresh-ms"));
if (!Number.isFinite(refreshMs) || refreshMs < 1000 || refreshMs > 10000) refreshMs = 5000;
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refresh();
    scheduleRefresh();
  }, refreshMs);
}

const rslide = $("#rslide");
const rrange = $("#rrange");
function closeRefreshEdit(apply) {
  if (rslide.hidden) return;
  if (apply) {
    const sec = Math.min(10, Math.max(1, Number(rrange.value) || 5));
    refreshMs = sec * 1000;
    try { localStorage.setItem("kp-refresh-ms", String(refreshMs)); } catch {}
    scheduleRefresh();
    refresh();
  }
  rslide.hidden = true;
  $("#stamp").hidden = false;
  $("#stamp").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

$("#stamp").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  $("#stamp").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
});
$("#stamp").addEventListener("dblclick", () => {
  if (!rslide.hidden) return;
  rrange.value = Math.round(refreshMs / 1000);
  $("#rval").textContent = rrange.value;
  $("#stamp").hidden = true;
  rslide.hidden = false;
  rrange.focus();
});
rrange.addEventListener("input", () => { $("#rval").textContent = rrange.value; });
rrange.addEventListener("blur", () => closeRefreshEdit(true));
rrange.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); closeRefreshEdit(true); }
  else if (e.key === "Escape") { e.preventDefault(); closeRefreshEdit(false); }
});

refresh();
scheduleRefresh();
</script>
</body>
</html>`;


function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求太大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("内容不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

function writeConfigAtomic(configPath, raw) {
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, configPath);
}

export async function handleUi(req, res, url, ctx) {
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE);
    return true;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    // 只接受同源页面：浏览器跨站发来的请求一定带 Origin，直接拒
    const origin = String(req.headers.origin || "");
    if (origin && !origin.startsWith("http://127.0.0.1") && !origin.startsWith("http://localhost")) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return true;
    }
    if (ctx.refreshQuota) ctx.refreshQuota();
    const cfg = ctx.getConfig();
    const snap = ctx.usage ? ctx.usage() : { keys: {}, todayTotals: {} };
    const now = Date.now();
    const keys = cfg.keys.map((k) => {
      const s = ctx.state(k.name);
      const u = snap.keys[k.name] || { today: {}, total: {} };
      const bd = ctx.breakdown ? ctx.breakdown(k.name) : null;
      return {
        key: k.key,
        quota: ctx.quota ? ctx.quota(k.name) : null,
        score: bd ? Math.round(bd.total * 10) / 10 : null,
        breakdown: bd,
        usage: {
          input: u.today.input || 0,
          output: u.today.output || 0,
          cost: u.today.cost || 0,
          totalInput: u.total.input || 0,
          totalOutput: u.total.output || 0,
          totalCost: u.total.cost || 0,
        },
        name: k.name,
        masked: ctx.mask(k.key),
        enabled: k.enabled !== false,
        ready: s.cooldownUntil <= now,
        cooldownSeconds: Math.max(0, Math.ceil((s.cooldownUntil - now) / 1000)),
        active: s.active,
        fails: s.fails,
        maxConcurrent: k.maxConcurrent || 0,
        requests: s.total,
        ok: s.ok,
        rateLimited: s.rateLimited,
        authErrors: s.authErrors,
        lastStatus: s.lastStatus,
      };
    });
    const body = JSON.stringify({
      ok: true,
      keys,
      today: snap.today,
      todayTotals: snap.todayTotals || {},
      targets: (cfg.routing && cfg.routing.targetShare) || null,
      weights: {
        loadPoints: cfg.routing ? cfg.routing.loadPoints : null,
        failPoints: cfg.routing ? cfg.routing.failPoints : null,
      },
      windowWeights: (cfg.routing && cfg.routing.windowWeights) || null,
      totals: snap.totals || {},
      configPath: ctx.configPath,
    });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }

  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    if (!sameOrigin(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "只接受本机页面的操作" }));
      return true;
    }
    let payload;
    try {
      payload = await readJsonBody(req);
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return true;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(ctx.configPath, "utf8"));
      raw.keys = Array.isArray(raw.keys) ? raw.keys : [];
      const name = String(payload.name || "").trim();

      if (url.pathname === "/api/keys") {
        const key = String(payload.key || "").trim();
        if (!name) throw new Error("名字不能空");
        if (name.length > 40) throw new Error("名字太长");
        if (!key) throw new Error("钥匙不能空");
        if (/\s/.test(key)) throw new Error("钥匙里不能有空格");
        if (ctx.validateKey) {
          const v = await ctx.validateKey(key);
          if (!v.ok) throw new Error(v.reason || "钥匙无效");
          if (v.warning) res.setHeader("x-keypool-warning", encodeURIComponent(v.warning));
        }
        const max = Number(payload.maxConcurrent);
        const entry = raw.keys.find((k) => k.name === name);
        if (entry) {
          entry.key = key;
          entry.enabled = true;
          if (Number.isFinite(max) && max >= 0) entry.maxConcurrent = max;
        } else {
          raw.keys.push({
            name,
            key,
            route: "opencode-go",
            maxConcurrent: Number.isFinite(max) && max >= 0 ? max : 10,
            enabled: true,
          });
        }
      } else if (url.pathname === "/api/keys/update") {
        const entry = raw.keys.find((k) => k.name === name);
        if (!entry) throw new Error("没有这把钥匙");
        if (typeof payload.enabled === "boolean") entry.enabled = payload.enabled;
        const max = Number(payload.maxConcurrent);
        if (payload.maxConcurrent !== undefined && Number.isFinite(max) && max >= 0) entry.maxConcurrent = max;
        if (payload.key) {
          const nk = String(payload.key).trim();
          if (ctx.validateKey) {
            const v = await ctx.validateKey(nk);
            if (!v.ok) throw new Error(v.reason || "钥匙无效");
          }
          entry.key = nk;
        }
      } else if (url.pathname === "/api/keys/rename") {
        const from = String(payload.from || payload.name || "").trim();
        const to = String(payload.to || "").trim();
        if (!from) throw new Error("缺少原名");
        if (!to) throw new Error("名字不能空");
        if (to.length > 40) throw new Error("名字太长");
        const entry = raw.keys.find((k) => k.name === from);
        if (!entry) throw new Error("没有这把钥匙");
        if (to !== from && raw.keys.some((k) => k.name === to)) throw new Error("已有同名钥匙");
        entry.name = to;
        ctx.renameExtra?.(from, to);
      } else if (url.pathname === "/api/routing") {
        const cur = (raw.routing && raw.routing.targetShare) || {};
        const pickNum = (w, dflt) => {
          const v = Number(payload.targetShare && payload.targetShare[w]);
          if (Number.isFinite(v)) return Math.min(100, Math.max(5, v)) / 100;
          const oldVal = Number(cur[w]);
          return Number.isFinite(oldVal) && oldVal > 0 && oldVal <= 1 ? oldVal : dflt;
        };
        const pickW = (key, dflt, max) => {
          const v = Number(payload.weights && payload.weights[key]);
          if (Number.isFinite(v)) return Math.min(max, Math.max(0, v));
          const oldVal = Number(raw.routing && raw.routing[key]);
          return Number.isFinite(oldVal) && oldVal >= 0 ? oldVal : dflt;
        };
        const curShare = (raw.routing && raw.routing.windowWeights) || {};
        const pickShare = (key, dflt) => {
          const v = Number(payload.windowWeights && payload.windowWeights[key]);
          if (Number.isFinite(v)) return Math.min(2, Math.max(0, v));
          const oldVal = Number(curShare[key]);
          return Number.isFinite(oldVal) && oldVal >= 0 ? oldVal : dflt;
        };
        raw.routing = {
          ...(raw.routing || {}),
          targetShare: {
            rolling: pickNum("rolling", 1),
            weekly: pickNum("weekly", 0.8),
            monthly: pickNum("monthly", 0.6),
          },
          loadPoints: pickW("loadPoints", 0.3, 5),
          failPoints: pickW("failPoints", 1, 10),
          windowWeights: {
            rolling: pickShare("rolling", 0.2),
            weekly: pickShare("weekly", 0.5),
            monthly: pickShare("monthly", 1),
          },
        };
      } else if (url.pathname === "/api/keys/delete") {
        const before = raw.keys.length;
        raw.keys = raw.keys.filter((k) => k.name !== name);
        if (raw.keys.length === before) throw new Error("没有这把钥匙");
        ctx.removeExtra?.(name);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "未知操作" }));
        return true;
      }

      writeConfigAtomic(ctx.configPath, raw);
      ctx.reload();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  return false;
}
