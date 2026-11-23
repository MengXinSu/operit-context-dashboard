// 把 dist 的 js/css 内联进 index.html，产出单文件 index.single.html
// 背景：Chromium WebView 下 file:// 页面加载 file:// 子资源会被 CORS 拦截
// （origin 'null'）。单文件产物可在 file:// / loadHtml 下直接运行。
// 用法：node inline.mjs dist
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || 'dist'
const htmlPath = join(dir, 'index.html')
let html = readFileSync(htmlPath, 'utf8')

// 内联 CSS（函数式替换：避免 $&/$' 等模式在替换串里被展开）
for (const m of [...html.matchAll(/<link[^>]+href="([^"]+\.css)"[^>]*>/g)]) {
  const p = join(dir, m[1].replace(/^\.\//, ''))
  if (existsSync(p)) {
    const css = readFileSync(p, 'utf8')
    html = html.replace(m[0], () => `<style>\n${css}\n</style>`)
  }
}

// 内联 module JS（把内容里的 </script> 转义，避免提前闭合；同样函数式替换）
for (const m of [...html.matchAll(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/g)]) {
  const p = join(dir, m[1].replace(/^\.\//, ''))
  if (existsSync(p)) {
    const js = readFileSync(p, 'utf8').replace(/<\/script>/g, '<\\/script>')
    html = html.replace(m[0], () => `<script type="module">\n${js}\n</script>`)
  }
}

const out = join(dir, 'index.single.html')
writeFileSync(out, html)
console.log('inline done:', out, html.length, 'chars')
