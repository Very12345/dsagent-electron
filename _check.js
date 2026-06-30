var fs = require('fs');
var h = fs.readFileSync('agentview.html', 'utf8');
var ok = true, idx = 0;
while (true) {
    var s = h.indexOf('<script>', idx);
    if (s < 0) break;
    var e = h.indexOf('</script>', s + 8);
    if (e < 0) break;
    try { require('vm').compileFunction(h.slice(s + 8, e)); }
    catch (err) { console.log('ERROR at ' + s + ': ' + err.message); ok = false; }
    idx = e + 9;
}
if (ok) console.log('ALL OK');
