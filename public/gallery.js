import { CHARACTERS } from './service-config.js';
import { bindTheme } from './theme.js';

const characters = Object.entries(CHARACTERS);
const gallery = document.querySelector('#characters');
const template = document.querySelector('#character-card');

for (const portrait of document.querySelectorAll('[data-featured-avatar]')) {
  portrait.src = CHARACTERS[portrait.dataset.featuredAvatar].image;
}

characters.forEach(([id, character], index) => {
  const card = template.content.cloneNode(true);
  const link = card.querySelector('a');
  link.href = '/avatar/' + encodeURIComponent(id);
  link.dataset.avatar = id;
  link.setAttribute('aria-label', '与' + character.name + '对话 · ' + character.role);
  card.querySelector('img').src = character.image;
  card.querySelector('.card-index').textContent = String(index + 1).padStart(2, '0');
  card.querySelector('.card-role').textContent = character.role;
  card.querySelector('.card-name').textContent = character.name;
  card.querySelector('.card-description').textContent = character.description;
  gallery.append(card);
});

document.querySelector('#cast-count').textContent = characters.length + ' 位角色';
bindTheme();
