var fs = require('fs');
var h = fs.readFileSync('agentview.html', 'utf8');
var o = (h.match(/<div\b[^>]*>/g) || []).length;
var c = (h.match(/<\/div>/g) || []).length;
console.log('div open:', o, 'close:', c, 'diff:', o - c);
var so = (h.match(/<script\b[^>]*>/g) || []).length;
var sc = (h.match(/<\/script>/g) || []).length;
console.log('script open:', so, 'close:', sc, 'diff:', so - sc);
// Check for specific issues
console.log('unclosed <div> tags:', o - c);
console.log('unclosed <script>:', so - sc);
