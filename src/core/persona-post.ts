// core/persona-post.ts — единый дом правила формирования текста поста персоны с
// инвайт-ссылкой: строки, целиком являющиеся URL, убираются, новая ссылка
// дописывается тремя строками в хвост. Используется и при создании канала в фазе 2
// (пост сразу с персональной ссылкой), и при перепубликации закрепа
// (private-invite-links / updatePersonalChannelPostLink).

const LINK_LINE = /^https?:\/\/\S+$/;

/** Убирает строки-URL из текста и дописывает `link` тремя строками в хвост. */
export function buildPostTextWithInviteLink(postText: string, link: string): string {
    const kept = postText.split("\n").filter((line) => !LINK_LINE.test(line.trim()));
    const base = kept.join("\n").replace(/\s+$/u, "");
    return `${base}\n${link}\n${link}\n${link}`;
}
