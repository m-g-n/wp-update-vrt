import { runCLI } from '@wp-playground/cli'

export const PHP_VERSION = '8.2'
export const THEME = 'twentytwentyfive'
const DEBUG_LOG = '/tmp/wp-debug.log'
const MARK = '@@VRT@@'

// VRT 中は外部への HTTP を止め（再現性と安全のため）、管理バーを消す（訪問者の見た目にそろえる）
const MU_PLUGIN = `<?php
add_filter('pre_http_request', function ($pre, $args, $url) {
    $host = parse_url($url, PHP_URL_HOST);
    if (in_array($host, ['127.0.0.1', 'localhost'], true)) return $pre;
    return new WP_Error('vrt_blocked', 'external HTTP blocked');
}, 10, 3);
add_filter('show_admin_bar', '__return_false');
`

// プラグインが有効化時などに何かを出力しても取り違えないよう、印の後ろだけを読む
export function parseMarked(text) {
  const i = text.lastIndexOf(MARK)
  if (i < 0) throw new Error('PHP の実行結果に印が無い')
  return JSON.parse(text.slice(i + MARK.length))
}

export async function runPhp(site, body) {
  const code = `<?php
require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/admin.php';
function vrt_out($v) { echo "\\n${MARK}" . json_encode($v); }
${body}`
  const res = await site.cli.playground.run({ code })
  return parseMarked(res.text)
}

export async function bootSite({ port }) {
  const cli = await runCLI({
    command: 'server',
    php: PHP_VERSION,
    wp: 'latest',
    login: true,
    port,
    verbosity: 'quiet',
    'define-bool': { WP_DEBUG: true, WP_DEBUG_DISPLAY: false },
    define: { WP_DEBUG_LOG: DEBUG_LOG },
  })
  const site = { cli, env: null }
  try {
    await cli.playground.mkdir('/wordpress/wp-content/mu-plugins')
    await cli.playground.writeFile('/wordpress/wp-content/mu-plugins/vrt-guard.php', MU_PLUGIN)
    site.env = await runPhp(site, `
if (wp_get_theme('${THEME}')->exists()) switch_theme('${THEME}');
vrt_out(['wp' => get_bloginfo('version'), 'php' => '${PHP_VERSION}', 'theme' => get_stylesheet()]);`)
  } catch (err) {
    // 起動後の初期化に失敗したまま放置すると、Playground サーバーが破棄されず残ってしまう
    await cli[Symbol.asyncDispose]().catch(() => {})
    throw err
  }
  return site
}

// 旧版の導入と新版への更新は同じ手順。overwrite_package で上書きし、実サイトの更新と同じく更新時の処理も走らせる
export async function installPlugin(site, zipBuffer) {
  await site.cli.playground.writeFile('/tmp/vrt-plugin.zip', new Uint8Array(zipBuffer))
  const out = await runPhp(site, `
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
$u = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$ok = $u->install('/tmp/vrt-plugin.zip', ['overwrite_package' => true]);
wp_clean_plugins_cache();
$file = $u->plugin_info();
$act = $file ? activate_plugin($file) : new WP_Error('no_plugin_file', '');
// unexpected_output は「有効化はできたが、その際に何か出力した」。実サイトでも有効なので成功として扱う
$err = is_wp_error($act) && $act->get_error_code() !== 'unexpected_output' ? $act->get_error_code() : null;
vrt_out(['ok' => $ok === true && is_plugin_active($file), 'file' => $file, 'error' => $err]);`)
  if (!out.ok || out.error) throw new Error(`プラグインを有効化できない (${out.error ?? 'install_failed'})`)
  return out.file
}

// 現在登録されているショートコードのタグを全部返す。旧版導入前の core ベースラインにも、
// 旧版導入後の「プラグインが足したタグ」の判定にも同じ問い合わせを使う
export async function listShortcodes(site) {
  return runPhp(site, 'global $shortcode_tags; vrt_out(array_keys($shortcode_tags));')
}

export async function debugLogLength(site) {
  const pg = site.cli.playground
  return (await pg.fileExists(DEBUG_LOG)) ? (await pg.readFileAsText(DEBUG_LOG)).length : 0
}

// start から end（省略時は末尾）までの PHP のエラー行。旧版と新版の比較は newErrors（capture.mjs）で行う
export async function debugLogLines(site, start, end) {
  const pg = site.cli.playground
  if (!(await pg.fileExists(DEBUG_LOG))) return []
  return (await pg.readFileAsText(DEBUG_LOG))
    .slice(start, end)
    .split('\n')
    .filter((l) => /PHP (Warning|Fatal error|Parse error|Notice|Deprecated)/.test(l))
}
