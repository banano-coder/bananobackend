const bcrypt = require('bcrypt');

(async () => {
  const plain = 'jhumks';            
  const hash = await bcrypt.hash(plain, 10);
  console.log('HASH =>', hash);
})();

