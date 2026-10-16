<?php
/**
 * Plugin Name: RCWriter SEO Bridge
 * Description: Lets RCWriter set the SEO focus keyword, meta description and SEO score over the WordPress REST API, for Rank Math and Yoast. Install once: copy this file into wp-content/mu-plugins/ (create that folder if it does not exist). No activation needed.
 * Version: 1.0.0
 * Author: Rustom Codilan
 * Author URI: https://tomdigitalspace.com/
 */

if (!defined('ABSPATH')) { exit; }

/**
 * Register the SEO plugins' post meta for the REST API so an authenticated
 * application (RCWriter) can write them. WordPress otherwise refuses to write
 * these keys over REST — which is why the focus keyword shows as "Not set".
 */
add_action('init', function () {
    $auth = function () { return current_user_can('edit_posts'); };
    $string = array('type' => 'string', 'single' => true, 'show_in_rest' => true, 'auth_callback' => $auth);
    $keys = array(
        // Rank Math
        'rank_math_focus_keyword', 'rank_math_description', 'rank_math_title',
        // Yoast
        '_yoast_wpseo_focuskw', '_yoast_wpseo_metadesc', '_yoast_wpseo_title',
    );
    foreach (array('post', 'page') as $type) {
        foreach ($keys as $key) {
            register_post_meta($type, $key, $string);
        }
    }
});

/**
 * After a post is created or updated through REST with a focus keyword, store a
 * Rank Math SEO score computed from the same on-page checks Rank Math uses, so
 * the posts list shows a real score instead of N/A. Rank Math recalculates its
 * own score when the post is opened in the editor; this keeps them close.
 */
function rcwriter_seo_compute_score($post_id) {
    $post = get_post($post_id);
    if (!$post || $post->post_type !== 'post') { return; }
    $kw = trim((string) get_post_meta($post_id, 'rank_math_focus_keyword', true));
    if ($kw === '') { $kw = trim((string) get_post_meta($post_id, '_yoast_wpseo_focuskw', true)); }
    if ($kw === '') { return; }
    // Primary keyphrase is the first in a comma-separated list.
    $parts = explode(',', $kw);
    $key = strtolower(trim($parts[0]));
    if ($key === '') { return; }

    $title = strtolower(get_the_title($post_id));
    $content_html = (string) $post->post_content;
    $content = strtolower(trim(wp_strip_all_tags($content_html)));
    $desc = strtolower((string) get_post_meta($post_id, 'rank_math_description', true));
    if ($desc === '') { $desc = strtolower((string) get_post_meta($post_id, '_yoast_wpseo_metadesc', true)); }
    $slug = strtolower($post->post_name);
    $words = str_word_count($content);
    $first10 = substr($content, 0, max(120, (int) (strlen($content) * 0.1)));
    $has = function ($hay) use ($key) { return $key !== '' && strpos($hay, $key) !== false; };

    $score = 0;
    if ($has($title))                         { $score += 12; }
    if (strpos($title, $key) === 0)           { $score += 6; }   // keyphrase at the start of the title
    if ($has($first10))                       { $score += 12; }
    if ($has($content))                       { $score += 10; }
    if (preg_match('/<h[2-4][^>]*>[^<]*' . preg_quote($key, '/') . '/i', strtolower($content_html))) { $score += 7; }
    if ($has($slug))                          { $score += 6; }
    if ($has($desc))                          { $score += 7; }
    if ($words >= 600)                        { $score += 8; }
    if ($words >= 1200)                       { $score += 6; }
    // Keyphrase density 0.5%–2.5%
    if ($words > 0) {
        $count = substr_count($content, $key);
        $density = ($count * max(1, count(explode(' ', $key)))) / $words * 100;
        if ($density >= 0.5 && $density <= 2.5) { $score += 8; }
    }
    $home = preg_quote(wp_parse_url(home_url(), PHP_URL_HOST), '/');
    if (preg_match('/<a\s[^>]*href=["\']https?:\/\/(?!' . $home . ')/i', $content_html)) { $score += 6; } // external link
    if (preg_match('/<a\s[^>]*href=["\'][^"\']*' . $home . '/i', $content_html))         { $score += 6; } // internal link
    if (has_post_thumbnail($post_id) || strpos($content_html, '<img') !== false)         { $score += 4; }
    $thumb_id = get_post_thumbnail_id($post_id);
    if ($thumb_id) { $alt = strtolower((string) get_post_meta($thumb_id, '_wp_attachment_image_alt', true)); if ($has($alt)) { $score += 4; } }
    $tlen = strlen(get_the_title($post_id));
    if ($tlen >= 40 && $tlen <= 65)           { $score += 4; }

    $score = max(0, min(100, $score));
    update_post_meta($post_id, 'rank_math_seo_score', $score);
}

// Fires on REST inserts/updates for posts (RCWriter publishes over REST).
add_action('rest_after_insert_post', function ($post) {
    if (is_object($post) && isset($post->ID)) { rcwriter_seo_compute_score($post->ID); }
}, 20, 1);
