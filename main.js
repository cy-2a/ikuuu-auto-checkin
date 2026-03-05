import { appendFileSync } from "fs";

const host = process.env.HOST || "ikuuu.nl";
const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;

// 配置通知 API 前缀
const NOTIFY_API_BASE = "https://api.chuckfang.com/第五个季节/";

// 格式化 Cookie
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();
  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) {
      cookiePairs.set(match[1].trim(), match[2].trim());
    }
  }
  return Array.from(cookiePairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

// 封装带超时和安全解析的请求函数
async function safeFetch(url, options, timeoutMs = 15000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...options, signal });
  
  const text = await response.text();
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} - ${text.slice(0, 50)}...`);
  }

  try {
    const json = JSON.parse(text);
    return { response, json };
  } catch (error) {
    // 预判：如果返回的不是 JSON，通常是被 Cloudflare 拦截或网站维护 (返回了 HTML)
    throw new Error(`解析响应失败，服务器可能异常或开启了验证: ${text.slice(0, 50)}...`);
  }
}

// 登录获取 Cookie
async function logIn(account) {
  console.log(`${account.name}: 登录中...`);

  // 优化：使用 URLSearchParams 替代 FormData，更符合多数面板后端的规范，且载荷更小
  const params = new URLSearchParams();
  params.append("email", account.email);
  params.append("passwd", account.passwd);
  params.append("code", "");
  params.append("remember_me", "off");

  const { response, json } = await safeFetch(logInUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (json.ret !== 1) {
    throw new Error(`登录失败: ${json.msg || "未知错误"}`);
  }

  let rawCookieArray = response.headers.getSetCookie();
  if (!rawCookieArray || rawCookieArray.length === 0) {
    throw new Error(`获取 Cookie 失败，请检查账号状态`);
  }

  return { ...account, cookie: formatCookie(rawCookieArray) };
}

// 签到
async function checkIn(account) {
  const { json } = await safeFetch(checkInUrl, {
    method: "POST",
    headers: {
      Cookie: account.cookie,
    },
  });

  return json.msg || "签到成功 (未返回具体信息)";
}

// 处理单个账号
async function processSingleAccount(account) {
  const cookedAccount = await logIn(account);
  const checkInResult = await checkIn(cookedAccount);
  return checkInResult;
}

// 设置 GitHub Output (保留用于 GitHub 界面日志查看)
function setGitHubOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    // 处理多行文本转义，防止 GitHub Actions 截断输出
    const eof = "EOF";
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${eof}\n${value}\n${eof}\n`);
  }
}

// 发送自定义 API 通知
async function sendNotification(message) {
  try {
    const targetUrl = `${NOTIFY_API_BASE}${encodeURIComponent(message)}`;
    // 发送 GET 请求
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      console.log("=> 通知发送成功");
    } else {
      console.error(`=> 通知发送失败: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`=> 通知发送异常: ${err.message}`);
  }
}

// 入口
async function main() {
  let accounts;

  try {
    if (!process.env.ACCOUNTS) {
      throw new Error("未配置账户信息 (Secrets: ACCOUNTS)");
    }
    accounts = JSON.parse(process.env.ACCOUNTS);
  } catch (error) {
    const msg = `❌ ${error.message.includes("JSON") ? "账户信息配置格式错误(非有效JSON)" : error.message}`;
    console.error(msg);
    setGitHubOutput("result", msg);
    await sendNotification(`配置文件异常: ${msg}`);
    process.exit(1);
  }

  // 并发执行所有账号任务
  const allPromises = accounts.map((account) => processSingleAccount(account));
  const results = await Promise.allSettled(allPromises);

  console.log("\n======== 签到结果 ========\n");

  let hasError = false;
  const resultLines = results.map((result, index) => {
    const accountName = accounts[index].name;
    const isSuccess = result.status === "fulfilled";

    if (!isSuccess) {
      hasError = true;
    }

    const message = isSuccess ? result.value : result.reason.message;
    // 按照你所需的格式构建字符串
    const line = `${accountName}: ${message}`;

    isSuccess ? console.log(`✅ ${line}`) : console.error(`❌ ${line}`);
    return line;
  });

  const resultMsg = resultLines.join("\n");
  setGitHubOutput("result", resultMsg);

  // 调用你的自定义 API 接口进行推送
  await sendNotification(resultMsg);

  if (hasError) {
    process.exit(1);
  }
}

main();
