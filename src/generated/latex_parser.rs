fn parse_cd_group(line: &str, mut i: usize) -> (String, usize) {
    let b = line.as_bytes();
    if i < b.len() && b[i] == b'{' {
        let mut depth = 1i32;
        i += 1;
        let start = i;
        while i < b.len() && depth > 0 {
            if b[i] == b'{' {
                depth += 1;
            } else if b[i] == b'}' {
                depth -= 1;
            }
            if depth > 0 {
                i += 1;
            }
        }
        let text = line[start..i].to_string();
        if i < b.len() && b[i] == b'}' {
            i += 1;
        }
        return (text, i);
    }
    let start = i;
    while i < b.len() {
        let ch = b[i] as char;
        if matches!(ch, '@' | '>' | '<' | 'A' | 'V' | '|' | '=' | '.') {
            break;
        }
        i += 1;
    }
    (line[start..i].to_string(), i)
}

fn cd_labeled_arrow(ch: &str, over: &str, under: &str) -> String {
    let mut inner = format!("<mo>{ch}</mo>");
    let top = if over.is_empty() {
        String::new()
    } else {
        latex_to_mathml(over, None, 0)
    };
    let bot = if under.is_empty() {
        String::new()
    } else {
        latex_to_mathml(under, None, 0)
    };
    if !top.is_empty() && !bot.is_empty() {
        inner = format!("<munderover>{inner}{bot}{top}</munderover>");
    } else if !top.is_empty() {
        inner = format!("<mover>{inner}{top}</mover>");
    } else if !bot.is_empty() {
        inner = format!("<munder>{inner}{bot}</munder>");
    }
    inner
}

fn parse_cd_arrow(line: &str, mut i: usize) -> (String, usize) {
    let b = line.as_bytes();
    if i >= b.len() || b[i] != b'@' {
        return (String::new(), i);
    }
    i += 1;
    if i >= b.len() {
        return (String::new(), i);
    }
    match b[i] {
        b'.' => (String::new(), i + 1),
        b'=' => ("<mo>=</mo>".into(), i + 1),
        b'|' => ("<mo>∥</mo>".into(), i + 1),
        b'>' | b'<' => {
            let dir = b[i];
            let mark = dir;
            i += 1;
            let (a, ni) = parse_cd_group(line, i);
            i = ni;
            if i >= b.len() || b[i] != mark {
                return (
                    cd_labeled_arrow(if dir == b'>' { "→" } else { "←" }, &a, ""),
                    i,
                );
            }
            i += 1;
            let (bb, ni) = parse_cd_group(line, i);
            i = ni;
            if i < b.len() && b[i] == mark {
                i += 1;
            }
            (
                cd_labeled_arrow(if dir == b'>' { "→" } else { "←" }, &a, &bb),
                i,
            )
        }
        b'A' | b'V' => {
            let mark = b[i];
            let ch = if mark == b'A' { "↑" } else { "↓" };
            i += 1;
            let (a, ni) = parse_cd_group(line, i);
            i = ni;
            if i >= b.len() || b[i] != mark {
                return (cd_labeled_arrow(ch, &a, ""), i);
            }
            i += 1;
            let (bb, ni) = parse_cd_group(line, i);
            i = ni;
            if i < b.len() && b[i] == mark {
                i += 1;
            }
            (cd_labeled_arrow(ch, &a, &bb), i)
        }
        _ => (String::new(), i),
    }
}

fn expand_chem_expr(tex: &str) -> String {
    let s = tex.trim();
    let b = s.as_bytes();
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0usize;
    let read_bracket = |i: &mut usize| -> String {
        if *i >= b.len() || b[*i] != b'[' {
            return String::new();
        }
        *i += 1;
        let start = *i;
        let mut depth = 1i32;
        while *i < b.len() && depth > 0 {
            if b[*i] == b'[' {
                depth += 1;
            } else if b[*i] == b']' {
                depth -= 1;
            }
            if depth > 0 {
                *i += 1;
            }
        }
        let text = s[start..*i].to_string();
        if *i < b.len() && b[*i] == b']' {
            *i += 1;
        }
        text
    };
    let read_group = |i: &mut usize| -> String {
        if *i < b.len() && b[*i] == b'{' {
            *i += 1;
            let mut depth = 1i32;
            let mut out = String::new();
            while *i < b.len() && depth > 0 {
                let ch = b[*i] as char;
                *i += 1;
                if ch == '{' {
                    depth += 1;
                } else if ch == '}' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                if depth > 0 {
                    out.push(ch);
                }
            }
            return out;
        }
        if *i < b.len() {
            let ch = b[*i] as char;
            *i += 1;
            ch.to_string()
        } else {
            String::new()
        }
    };
    while i < b.len() {
        if s[i..].starts_with("<=>") || s[i..].starts_with("<->") {
            parts.push("<mo>⇌</mo>".into());
            i += 3;
            continue;
        }
        if s[i..].starts_with("->") || s[i..].starts_with("<-") {
            let right = s[i..].starts_with("->");
            i += 2;
            let over = read_bracket(&mut i);
            let under = read_bracket(&mut i);
            let mut arrow = format!("<mo>{}</mo>", if right { "→" } else { "←" });
            let top = if over.is_empty() {
                String::new()
            } else {
                latex_to_mathml(&over, None, 0)
            };
            let bot = if under.is_empty() {
                String::new()
            } else {
                latex_to_mathml(&under, None, 0)
            };
            if !top.is_empty() && !bot.is_empty() {
                arrow = format!("<munderover>{arrow}{bot}{top}</munderover>");
            } else if !top.is_empty() {
                arrow = format!("<mover>{arrow}{top}</mover>");
            } else if !bot.is_empty() {
                arrow = format!("<munder>{arrow}{bot}</munder>");
            }
            parts.push(arrow);
            continue;
        }
        if b[i] == b'^' {
            i += 1;
            let script = read_group(&mut i);
            let prev = parts.pop().unwrap_or_else(|| "<mrow/>".into());
            parts.push(format!(
                "<msup>{prev}{}</msup>",
                latex_to_mathml(&script, None, 0)
            ));
            continue;
        }
        if b[i] == b'_' {
            i += 1;
            let script = read_group(&mut i);
            let prev = parts.pop().unwrap_or_else(|| "<mrow/>".into());
            parts.push(format!(
                "<msub>{prev}{}</msub>",
                latex_to_mathml(&script, None, 0)
            ));
            continue;
        }
        if (b[i] as char).is_ascii_digit() {
            let mut n = String::new();
            while i < b.len() && (b[i] as char).is_ascii_digit() {
                n.push(b[i] as char);
                i += 1;
            }
            if parts
                .last()
                .is_some_and(|p| p.starts_with("<mi"))
            {
                let prev = parts.pop().unwrap();
                parts.push(format!("<msub>{prev}<mn>{n}</mn></msub>"));
            } else {
                parts.push(format!("<mn>{n}</mn>"));
            }
            continue;
        }
        if (b[i] as char).is_ascii_alphabetic() {
            let mut name = String::new();
            name.push(b[i] as char);
            i += 1;
            if i < b.len() && (b[i] as char).is_ascii_lowercase() {
                name.push(b[i] as char);
                i += 1;
            }
            parts.push(format!(
                "<mi mathvariant=\"normal\">{}</mi>",
                escape_live_html(&name)
            ));
            continue;
        }
        if matches!(b[i], b'+' | b'-' | b'(' | b')' | b'[' | b']') {
            let ch = b[i] as char;
            i += 1;
            parts.push(format!("<mo>{}</mo>", escape_live_html(&ch.to_string())));
            continue;
        }
        if (b[i] as char).is_whitespace() {
            i += 1;
            continue;
        }
        if b[i] == b'\\' {
            parts.push(latex_to_mathml(&s[i..], None, 0));
            break;
        }
        let ch = b[i] as char;
        i += 1;
        parts.push(format!("<mtext>{}</mtext>", escape_live_html(&ch.to_string())));
    }
    match parts.len() {
        0 => "<mrow/>".into(),
        1 => parts.remove(0),
        _ => format!("<mrow>{}</mrow>", parts.join("")),
    }
}

struct Parser<'a> {
    s: &'a str,
    i: usize,
    macros: Option<&'a MathMacroMap>,
    macro_depth: usize,
    font: MathFontState,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str, macros: Option<&'a MathMacroMap>, macro_depth: usize) -> Self {
        Self {
            s,
            i: 0,
            macros,
            macro_depth,
            font: DEFAULT_MATH_FONT,
        }
    }

    fn peek(&self) -> Option<char> {
        self.s[self.i.min(self.s.len())..].chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.i += c.len_utf8();
        Some(c)
    }

    fn starts_lit(&self, lit: &str) -> bool {
        self.s.get(self.i..).is_some_and(|t| t.starts_with(lit))
    }

    fn with_font(&mut self, patch: FontPatch, body: impl FnOnce(&mut Self) -> String) -> String {
        let prev = self.font;
        self.font = MathFontState {
            family: patch.family.unwrap_or(prev.family),
            series: patch.series.unwrap_or(prev.series),
            shape: patch.shape.unwrap_or(prev.shape),
        };
        let out = body(self);
        self.font = prev;
        out
    }

    fn emit_ident(&self, ch: &str) -> String {
        if is_default_font(self.font) {
            return format!("<mi>{}</mi>", escape_live_html(ch));
        }
        let glyph = styled_alphanum(ch, self.font);
        let attr = if needs_upright_mi(self.font) {
            " mathvariant=\"normal\""
        } else {
            ""
        };
        format!("<mi{attr}>{}</mi>", escape_live_html(&glyph))
    }

    fn emit_number(&self, n: &str) -> String {
        if is_default_font(self.font) || needs_upright_mi(self.font) {
            let attr = if needs_upright_mi(self.font) {
                " mathvariant=\"normal\""
            } else {
                ""
            };
            return format!("<mn{attr}>{n}</mn>");
        }
        let glyphs: String = n
            .chars()
            .map(|d| styled_alphanum(&d.to_string(), self.font))
            .collect();
        format!("<mn>{}</mn>", escape_live_html(&glyphs))
    }

    fn parse_expr(&mut self) -> String {
        let mut parts: Vec<String> = Vec::new();
        while self.i < self.s.len() {
            if self.peek() == Some('}') {
                break;
            }
            if self.peek() == Some('&') {
                self.i += 1;
                continue;
            }
            if matches!(self.peek(), Some('\n' | '\r')) {
                self.i += 1;
                continue;
            }
            parts.push(self.parse_with_scripts());
            self.skip_space();
            if self.starts_command("brack") || self.starts_command("brace") {
                let which = if self.starts_command("brack") {
                    "brack"
                } else {
                    "brace"
                };
                self.i += 1 + which.len();
                let right = self.parse_with_scripts();
                let left = parts.pop().unwrap_or_default();
                let (open, close) = if which == "brack" {
                    ("[", "]")
                } else {
                    ("{", "}")
                };
                parts.push(format!(
                    "<mrow><mo>{open}</mo><mfrac linethickness=\"0\">{left}{right}</mfrac><mo>{close}</mo></mrow>"
                ));
            }
        }
        match parts.len() {
            0 => String::new(),
            1 => parts.remove(0),
            _ => format!("<mrow>{}</mrow>", parts.join("")),
        }
    }

    fn parse_with_scripts(&mut self) -> String {
        let base = self.parse_nucleus();
        let mut sub: Option<String> = None;
        let mut sup: Option<String> = None;
        while self.i < self.s.len() {
            self.skip_space();
            if self.peek() == Some('_') {
                self.i += 1;
                sub = Some(self.parse_group_or_atom());
                continue;
            }
            if self.peek() == Some('^') {
                self.i += 1;
                sup = Some(self.parse_group_or_atom());
                continue;
            }
            if self.peek() == Some('\'') {
                self.i += 1;
                let primes = "<mo>′</mo>";
                sup = Some(match sup {
                    Some(s) => format!("<mrow>{s}{primes}</mrow>"),
                    None => primes.into(),
                });
                continue;
            }
            break;
        }
        let large = base.contains("largeop=\"true\"");
        match (sub, sup) {
            (Some(sub), Some(sup)) if large => {
                format!("<munderover>{base}{sub}{sup}</munderover>")
            }
            (Some(sub), Some(sup)) => format!("<msubsup>{base}{sub}{sup}</msubsup>"),
            (Some(sub), None) if large => format!("<munder>{base}{sub}</munder>"),
            (Some(sub), None) => format!("<msub>{base}{sub}</msub>"),
            (None, Some(sup)) if large => format!("<mover>{base}{sup}</mover>"),
            (None, Some(sup)) => format!("<msup>{base}{sup}</msup>"),
            (None, None) => base,
        }
    }

    fn parse_group_or_atom(&mut self) -> String {
        self.skip_space();
        if self.peek() == Some('{') {
            self.i += 1;
            let inner = self.parse_expr();
            if self.peek() == Some('}') {
                self.i += 1;
            }
            return if inner.is_empty() {
                "<mrow/>".into()
            } else {
                inner
            };
        }
        self.parse_nucleus()
    }

    fn parse_nucleus(&mut self) -> String {
        self.skip_space();
        if self.i >= self.s.len() {
            return String::new();
        }
        let ch = self.peek().unwrap();
        if ch == '{' {
            return self.parse_group_or_atom();
        }
        if ch == '\\' {
            return self.parse_command();
        }
        if ch == '.' && self.starts_lit("...") {
            self.i += 3;
            return "<mo>…</mo>".into();
        }
        self.bump();
        if ch.is_ascii_digit() {
            let mut n = ch.to_string();
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                n.push(self.bump().unwrap());
            }
            return self.emit_number(&n);
        }
        if ch.is_ascii_alphabetic() {
            return self.emit_ident(&ch.to_string());
        }
        if matches!(
            ch,
            '=' | '+'
                | '-'
                | '*'
                | '/'
                | ','
                | ':'
                | ';'
                | '('
                | ')'
                | '['
                | ']'
                | '|'
                | '<'
                | '>'
        ) {
            return format!("<mo>{}</mo>", escape_live_html(&ch.to_string()));
        }
        if ch == '\'' {
            return "<mo>′</mo>".into();
        }
        self.emit_ident(&ch.to_string())
    }

    fn parse_command(&mut self) -> String {
        self.i += 1;
        if self.i >= self.s.len() {
            return String::new();
        }
        let next = self.peek().unwrap();
        if !next.is_ascii_alphabetic() {
            self.bump();
            if matches!(next, ',' | ':' | ';' | ' ') {
                return "<mspace width='0.16em'/>".into();
            }
            if next == '\\' {
                return "<mspace linebreak='newline'/>".into();
            }
            if next == '{' || next == '}' {
                return format!("<mo>{next}</mo>");
            }
            if next == '_' || next == '%' {
                return format!("<mi>{}</mi>", escape_live_html(&next.to_string()));
            }
            return format!("<mo>{}</mo>", escape_live_html(&next.to_string()));
        }
        let mut name = String::new();
        while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            name.push(self.bump().unwrap());
        }
        self.skip_space();
        if let Some(macros) = self.macros
            && let Some(macro_) = macros.get(&name)
        {
            let m = macro_.clone();
            return self.expand_macro(&name, &m);
        }
        if let Some(patch) = math_font_cmd(&name) {
            return self.with_font(patch, |p| p.parse_group_or_atom());
        }
        if name == "left" {
            let open = self.read_delimiter();
            let mut parts: Vec<String> = Vec::new();
            while self.i < self.s.len() && self.peek() != Some('}') {
                self.skip_space();
                if self.at_fence_break() {
                    break;
                }
                if self.starts_command("right") {
                    self.i += 1 + "right".len();
                    let close = self.read_delimiter();
                    let inner = match parts.len() {
                        1 => parts.remove(0),
                        0 => String::new(),
                        _ => format!("<mrow>{}</mrow>", parts.join("")),
                    };
                    return self.wrap_fences(&open, &inner, Some(&close));
                }
                parts.push(self.parse_with_scripts());
            }
            let inner = match parts.len() {
                1 => parts.remove(0),
                0 => String::new(),
                _ => format!("<mrow>{}</mrow>", parts.join("")),
            };
            return self.wrap_fences(&open, &inner, None);
        }
        if name == "right" {
            return fence_mo(&self.read_delimiter());
        }
        if matches!(
            name.as_str(),
            "frac" | "dfrac" | "tfrac" | "cfrac" | "nicefrac" | "unitfrac"
        ) {
            if self.peek() == Some('[') {
                self.i += 1;
                self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
            }
            let a = self.parse_group_or_atom();
            let b = self.parse_group_or_atom();
            return format!("<mfrac>{a}{b}</mfrac>");
        }
        if matches!(name.as_str(), "binom" | "dbinom" | "tbinom") {
            let a = self.parse_group_or_atom();
            let b = self.parse_group_or_atom();
            return format!("<mfrac linethickness=\"0\">{a}{b}</mfrac>");
        }
        if name == "sqrt" {
            if self.peek() == Some('[') {
                self.i += 1;
                let idx = self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
                return format!("<mroot>{}{idx}</mroot>", self.parse_group_or_atom());
            }
            return format!("<msqrt>{}</msqrt>", self.parse_group_or_atom());
        }
        if is_text_plain(&name) || text_font_style(&name).is_some() {
            let inner = self.read_group_text();
            return if let Some(css) = text_font_style(&name) {
                format!(
                    "<mtext style=\"{css}\">{}</mtext>",
                    escape_live_html(&inner)
                )
            } else {
                format!("<mtext>{}</mtext>", escape_live_html(&inner))
            };
        }
        if name == "mbox" {
            return self.parse_group_or_atom();
        }
        if name == "makebox" {
            while self.peek() == Some('[') {
                self.i += 1;
                self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
            }
            return self.parse_group_or_atom();
        }
        if name == "parbox" {
            if self.peek() == Some('[') {
                self.i += 1;
                self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
            }
            if self.peek() == Some('{') {
                self.read_group_text();
            }
            return self.parse_group_or_atom();
        }
        if name == "genfrac" {
            let left = self.read_group_text();
            let right = self.read_group_text();
            let bar = self.read_group_text();
            self.read_group_text();
            let a = self.parse_group_or_atom();
            let b = self.parse_group_or_atom();
            let frac = if matches!(bar.as_str(), "0pt" | "0" | "0mm") {
                format!("<mfrac linethickness=\"0\">{a}{b}</mfrac>")
            } else {
                format!("<mfrac>{a}{b}</mfrac>")
            };
            if left.is_empty() && right.is_empty() {
                return frac;
            }
            return format!(
                "<mrow>{}{frac}{}</mrow>",
                if left.is_empty() {
                    String::new()
                } else {
                    format!("<mo>{}</mo>", escape_live_html(&left))
                },
                if right.is_empty() {
                    String::new()
                } else {
                    format!("<mo>{}</mo>", escape_live_html(&right))
                }
            );
        }
        if matches!(
            name.as_str(),
            "scriptstyle" | "scriptscriptstyle" | "textstyle" | "displaystyle"
        ) {
            let rest = self.parse_expr();
            if name == "scriptstyle" {
                return format!("<mstyle mathsize=\"75%\">{rest}</mstyle>");
            }
            if name == "scriptscriptstyle" {
                return format!("<mstyle mathsize=\"60%\">{rest}</mstyle>");
            }
            return rest;
        }
        if name == "raisebox" {
            let height = self.read_group_text();
            let height = height.trim();
            let inner = self.parse_group_or_atom();
            return format!(
                "<mpadded voffset=\"{}\">{inner}</mpadded>",
                escape_live_html(height)
            );
        }
        if name == "textcolor" {
            let color = self.read_group_text();
            let inner = self.parse_group_or_atom();
            return format!(
                "<mstyle mathcolor=\"{}\">{inner}</mstyle>",
                escape_live_html(&math_color(color.trim()))
            );
        }
        if name == "color" {
            let color = if self.peek() == Some('{') {
                self.read_group_text()
            } else {
                self.read_color_word()
            };
            let rest = self.parse_expr();
            return format!(
                "<mstyle mathcolor=\"{}\">{rest}</mstyle>",
                escape_live_html(&math_color(color.trim()))
            );
        }
        if name == "boxed" {
            return format!(
                "<menclose notation=\"box\">{}</menclose>",
                self.parse_group_or_atom()
            );
        }
        if name == "colorbox" {
            let color = self.read_group_text();
            let inner = self.parse_group_or_atom();
            return format!(
                "<mstyle mathbackground=\"{}\">{inner}</mstyle>",
                escape_live_html(&math_color(color.trim()))
            );
        }
        if name == "fcolorbox" {
            let frame = self.read_group_text();
            let fill = self.read_group_text();
            let inner = self.parse_group_or_atom();
            let border = math_color(frame.trim());
            let bg = math_color(fill.trim());
            return format!(
                "<menclose notation=\"box\" style=\"border:2px solid {};padding:0.15em\"><mstyle mathbackground=\"{}\">{inner}</mstyle></menclose>",
                escape_live_html(&border),
                escape_live_html(&bg)
            );
        }
        if name == "underline" || name == "underbar" {
            return format!(
                "<menclose notation=\"bottom\">{}</menclose>",
                self.parse_group_or_atom()
            );
        }
        if name == "fbox" || name == "framebox" {
            if self.peek() == Some('[') {
                self.i += 1;
                self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
            }
            return format!(
                "<menclose notation=\"box\">{}</menclose>",
                self.parse_group_or_atom()
            );
        }
        if name == "pmod" {
            let inner = self.parse_group_or_atom();
            return format!("<mrow><mo>(</mo><mtext>mod </mtext>{inner}<mo>)</mo></mrow>");
        }
        if name == "pod" {
            let inner = self.parse_group_or_atom();
            return format!("<mrow><mo>(</mo>{inner}<mo>)</mo></mrow>");
        }
        if name == "Bra" {
            return format!(
                "<mrow><mo>⟨</mo>{}<mo>|</mo></mrow>",
                self.parse_group_or_atom()
            );
        }
        if name == "Ket" {
            return format!(
                "<mrow><mo>|</mo>{}<mo>⟩</mo></mrow>",
                self.parse_group_or_atom()
            );
        }
        if name == "Braket" {
            return format!(
                "<mrow><mo>⟨</mo>{}<mo>⟩</mo></mrow>",
                self.parse_group_or_atom()
            );
        }
        if name == "cancel" {
            return format!(
                "<menclose notation=\"updiagonalstrike\">{}</menclose>",
                self.parse_group_or_atom()
            );
        }
        if name == "bcancel" {
            return format!(
                "<menclose notation=\"downdiagonalstrike\">{}</menclose>",
                self.parse_group_or_atom()
            );
        }
        if name == "xcancel" {
            return format!(
                "<menclose notation=\"updiagonalstrike downdiagonalstrike\">{}</menclose>",
                self.parse_group_or_atom()
            );
        }
        if name == "cancelto" {
            let to = self.parse_group_or_atom();
            let inner = self.parse_group_or_atom();
            return format!(
                "<msup><menclose notation=\"updiagonalstrike\">{inner}</menclose>{to}</msup>"
            );
        }
        if name == "sideset" {
            let left = self.read_group_text();
            let right = self.read_group_text();
            let op = self.parse_with_scripts();
            let left_scripts = self.parse_side_scripts(&left);
            let right_scripts = self.parse_side_scripts(&right);
            return format!(
                "<mmultiscripts>{op}{}{}<mprescripts/>{}{}</mmultiscripts>",
                right_scripts.0, right_scripts.1, left_scripts.0, left_scripts.1
            );
        }
        if name == "smashoperator" {
            if self.peek() == Some('[') {
                self.i += 1;
                self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
            }
            return self.parse_group_or_atom();
        }
        if name == "splitfrac" || name == "splitdfrac" {
            let a = self.parse_group_or_atom();
            let b = self.parse_group_or_atom();
            return format!("<mfrac>{a}{b}</mfrac>");
        }
        if name == "substack" {
            let raw = self.read_group_text();
            let rows: Vec<String> = raw
                .split("\\\\")
                .map(|row| {
                    format!(
                        "<mtr><mtd>{}</mtd></mtr>",
                        latex_to_mathml(row.trim(), None, 0)
                    )
                })
                .collect();
            return format!("<mtable>{}</mtable>", rows.join(""));
        }
        if name == "intertext" || name == "shortintertext" {
            let inner = self.read_group_text();
            return format!("<mtext>{}</mtext>", escape_live_html(&inner));
        }
        if name == "varliminf" {
            return "<munder><mi>lim</mi><mo>―</mo></munder>".into();
        }
        if name == "varlimsup" {
            return "<mover><mi>lim</mi><mo>―</mo></mover>".into();
        }
        if name == "varprojlim" {
            return "<munder><mi>lim</mi><mo>←</mo></munder>".into();
        }
        if name == "varinjlim" {
            return "<munder><mi>lim</mi><mo>→</mo></munder>".into();
        }
        if name == "relax" {
            return String::new();
        }
        if name == "footnotesize" || name == "scriptsize" {
            return self.parse_with_scripts();
        }
        if name == "unit" {
            let inner = if self.peek() == Some('{') {
                self.read_group_text()
            } else {
                self.read_color_word()
            };
            return format!("<mtext>{}</mtext>", escape_live_html(&inner));
        }
        if name == "uptau" {
            return "<mi>τ</mi>".into();
        }
        if name == "uppi" {
            return "<mi>π</mi>".into();
        }
        if name == "upmu" {
            return "<mi>μ</mi>".into();
        }
        if name == "upnu" {
            return "<mi>ν</mi>".into();
        }
        if matches!(
            name.as_str(),
            "hfill" | "negmedspace" | "negthickspace" | "negthinspace"
        ) {
            return "<mspace width='0.2em'/>".into();
        }
        if name == "hdotsfor" || name == "dotfill" {
            if self.peek() == Some('{') {
                self.read_group_text();
            }
            return "<mo>⋯</mo>".into();
        }
        if name == "hrulefill" {
            return "<mo>─</mo>".into();
        }
        if matches!(name.as_str(), "lefteqn" | "shoveleft" | "oldstylenums") {
            return self.parse_group_or_atom();
        }
        if name == "ensuremath" {
            if self.peek() == Some('{') {
                let inner = self.read_group_text();
                return latex_to_mathml(&inner, None, 0);
            }
            return self.parse_with_scripts();
        }
        if name == "ce" {
            if self.peek() == Some('{') {
                return expand_chem_expr(&self.read_group_text());
            }
            return self.parse_with_scripts();
        }
        if is_skip_next(&name) {
            return self.parse_with_scripts();
        }
        if is_skip_group(&name) {
            if self.peek() == Some('[') {
                self.i += 1;
                self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
            }
            if self.peek() == Some('{') {
                self.read_group_text();
            }
            return String::new();
        }
        if name == "quad" {
            return "<mspace width='1em'/>".into();
        }
        if name == "qquad" {
            return "<mspace width='2em'/>".into();
        }
        if name == "," || name == "thinspace" {
            return "<mspace width='0.16em'/>".into();
        }
        if matches!(name.as_str(), "phantom" | "hphantom" | "vphantom") {
            let inner = self.parse_group_or_atom();
            return format!("<mphantom>{inner}</mphantom>");
        }
        if name == "not" {
            let next = self.parse_with_scripts();
            if next == "<mo>=</mo>" {
                return "<mo>≠</mo>".into();
            }
            return format!("<menclose notation=\"updiagonalstrike\">{next}</menclose>");
        }
        if matches!(name.as_str(), "underset" | "overset" | "stackrel") {
            let acc = self.parse_group_or_atom();
            let base = self.parse_group_or_atom();
            return if name == "underset" {
                format!("<munder>{base}{acc}</munder>")
            } else {
                format!("<mover>{base}{acc}</mover>")
            };
        }
        if name.starts_with('x') && (name.contains("arrow") || name.contains("harpoon") || name.contains("hook"))
        {
            let mut under = String::new();
            let mut over = String::new();
            if self.peek() == Some('[') {
                self.i += 1;
                under = self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
            }
            if self.peek() == Some('{') {
                over = self.parse_group_or_atom();
            }
            let rest = name.strip_prefix('x').unwrap_or(name.as_str());
            let core = rest.strip_prefix("long").unwrap_or(rest);
            let ch = lookup_sym_mo(core)
                .or_else(|| lookup_sym_mo(&name))
                .unwrap_or(if name.to_ascii_lowercase().contains("left") {
                    "←"
                } else {
                    "→"
                });
            let arrow = format!("<mo>{ch}</mo>");
            if !under.is_empty() && !over.is_empty() {
                return format!("<munderover>{arrow}{under}{over}</munderover>");
            }
            if !over.is_empty() {
                return format!("<mover>{arrow}{over}</mover>");
            }
            if !under.is_empty() {
                return format!("<munder>{arrow}{under}</munder>");
            }
            return arrow;
        }
        if let Some(acc) = lookup_accent_over(&name) {
            let inner = self.parse_group_or_atom();
            return format!(
                "<mover>{inner}<mo>{}</mo></mover>",
                escape_live_html(acc)
            );
        }
        if let Some(acc) = lookup_accent_under(&name) {
            let inner = self.parse_group_or_atom();
            return format!(
                "<munder>{inner}<mo>{}</mo></munder>",
                escape_live_html(acc)
            );
        }
        if matches!(
            name.as_str(),
            "overbrace" | "underbrace" | "overbracket" | "underbracket"
        ) {
            if self.peek() == Some('[') {
                self.i += 1;
                self.parse_expr_until(']');
                if self.peek() == Some(']') {
                    self.i += 1;
                }
            }
            let inner = self.parse_group_or_atom();
            let over = name.starts_with("over");
            let bar = if over {
                if name.contains("bracket") {
                    "⎴"
                } else {
                    "⏞"
                }
            } else if name.contains("bracket") {
                "⎵"
            } else {
                "⏟"
            };
            let brace = if over {
                format!("<mover>{inner}<mo>{bar}</mo></mover>")
            } else {
                format!("<munder>{inner}<mo>{bar}</mo></munder>")
            };
            return self.attach_brace_limits(brace);
        }
        if is_big_cmd(&name) {
            return format!(
                "<mo>{}</mo>",
                escape_live_html(&self.read_delimiter())
            );
        }
        if name == "begin" {
            let env = self.read_group_text();
            if env == "CD" {
                return self.parse_cd();
            }
            if matrix_fences(&env).is_some() {
                return self.parse_matrix(&env);
            }
            return String::new();
        }
        if name == "end" {
            self.read_group_text();
            return String::new();
        }
        if let Some(ch) = largeop_char(&name) {
            return format!("<mo largeop=\"true\">{ch}</mo>");
        }
        if is_opname(&name) {
            return format!("<mi>{name}</mi>");
        }
        if let Some(ch) = lookup_sym_mo(&name) {
            return format!("<mo>{ch}</mo>");
        }
        if let Some(ch) = lookup_sym_mi(&name) {
            return self.emit_ident(ch);
        }
        if self.peek() == Some('{') {
            self.read_group_text();
        }
        format!("<mi>{}</mi>", escape_live_html(&format!("\\{name}")))
    }

    fn parse_cd(&mut self) -> String {
        let rest = &self.s[self.i..];
        let end_at = rest.find("\\end{CD}");
        let raw = if let Some(at) = end_at {
            rest[..at].trim()
        } else {
            rest.trim()
        };
        self.i = if let Some(at) = end_at {
            self.i + at + "\\end{CD}".len()
        } else {
            self.s.len()
        };
        let rows: Vec<String> = raw
            .split("\\\\")
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|line| {
                let cells = self.parse_cd_line(line);
                format!(
                    "<mtr>{}</mtr>",
                    cells
                        .into_iter()
                        .map(|c| format!("<mtd>{c}</mtd>"))
                        .collect::<Vec<_>>()
                        .join("")
                )
            })
            .collect();
        format!(
            "<mtable columnspacing=\"0.4em\" rowspacing=\"0.4em\">{}</mtable>",
            rows.join("")
        )
    }

    fn parse_cd_line(&self, line: &str) -> Vec<String> {
        let mut cells = Vec::new();
        let mut i = 0usize;
        let take_text = |i: &mut usize| -> String {
            let start = *i;
            while *i < line.len() && line.as_bytes()[*i] != b'@' {
                *i += 1;
            }
            let raw = line[start..*i].trim();
            if raw.is_empty() {
                String::new()
            } else {
                latex_to_mathml(raw, None, 0)
            }
        };
        if !line.starts_with('@') {
            cells.push(take_text(&mut i));
        }
        while i < line.len() {
            if line.as_bytes()[i] != b'@' {
                cells.push(take_text(&mut i));
                continue;
            }
            let (html, next) = parse_cd_arrow(line, i);
            i = next;
            cells.push(html);
            if i < line.len() && line.as_bytes()[i] != b'@' {
                cells.push(take_text(&mut i));
            }
        }
        if line.starts_with('@') {
            let mut padded = Vec::new();
            for (c, cell) in cells.iter().enumerate() {
                padded.push(cell.clone());
                if c < cells.len() - 1 {
                    padded.push(String::new());
                }
            }
            return padded;
        }
        cells
    }

    fn parse_matrix(&mut self, env: &str) -> String {
        self.skip_space();
        if self.peek() == Some('[') {
            self.i += 1;
            self.parse_expr_until(']');
            if self.peek() == Some(']') {
                self.i += 1;
            }
        }
        self.skip_space();
        if self.peek() == Some('{') {
            self.read_group_text();
        }
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut row: Vec<String> = Vec::new();
        loop {
            self.skip_space();
            if matches!(self.peek(), Some('\n' | '\r')) {
                self.i += 1;
                continue;
            }
            if self.starts_command("end") {
                self.i += 1 + "end".len();
                self.read_group_text();
                if !row.is_empty() {
                    rows.push(std::mem::take(&mut row));
                }
                break;
            }
            if self.i >= self.s.len() {
                if !row.is_empty() {
                    rows.push(std::mem::take(&mut row));
                }
                break;
            }
            let cell = self.parse_matrix_cell();
            row.push(if cell.is_empty() {
                "<mrow/>".into()
            } else {
                cell
            });
            self.skip_space();
            if self.peek() == Some('&') {
                self.i += 1;
                continue;
            }
            if self.starts_lit("\\\\") {
                self.i += 2;
                self.skip_space();
                if self.peek() == Some('[') {
                    self.i += 1;
                    self.parse_expr_until(']');
                    if self.peek() == Some(']') {
                        self.i += 1;
                    }
                }
                rows.push(std::mem::take(&mut row));
                continue;
            }
            if !row.is_empty() {
                rows.push(std::mem::take(&mut row));
            }
            if self.starts_command("end") {
                continue;
            }
            break;
        }
        let table = format!(
            "<mtable>{}</mtable>",
            rows.iter()
                .map(|r| format!(
                    "<mtr>{}</mtr>",
                    r.iter()
                        .map(|c| format!("<mtd>{c}</mtd>"))
                        .collect::<String>()
                ))
                .collect::<String>()
        );
        let (open, close) = matrix_fences(env).unwrap_or(("", ""));
        if open.is_empty() && close.is_empty() {
            return table;
        }
        let close_html = if close.is_empty() {
            String::new()
        } else {
            format!("<mo>{}</mo>", escape_live_html(close))
        };
        format!(
            "<mrow><mo>{}</mo>{table}{close_html}</mrow>",
            escape_live_html(open)
        )
    }

    fn parse_matrix_cell(&mut self) -> String {
        let mut parts: Vec<String> = Vec::new();
        while self.i < self.s.len() {
            self.skip_space();
            if self.peek() == Some('&') {
                break;
            }
            if self.starts_lit("\\\\") {
                break;
            }
            if self.starts_command("end") {
                break;
            }
            if matches!(self.peek(), Some('\n' | '\r')) {
                self.i += 1;
                continue;
            }
            parts.push(self.parse_with_scripts());
        }
        match parts.len() {
            0 => String::new(),
            1 => parts.remove(0),
            _ => format!("<mrow>{}</mrow>", parts.join("")),
        }
    }

    fn expand_macro(&mut self, name: &str, macro_: &MathMacro) -> String {
        if self.macro_depth >= MAX_MACRO_EXPANSION_DEPTH {
            return format!("<mtext>\\{name}</mtext>");
        }
        let mut args: Vec<String> = Vec::new();
        let mut mandatory = macro_.nargs;
        if macro_.optional_default.is_some() && mandatory > 0 {
            if self.peek() == Some('[') {
                self.i += 1;
                let mut raw = String::new();
                while self.i < self.s.len() && self.peek() != Some(']') {
                    raw.push(self.bump().unwrap());
                }
                if self.peek() == Some(']') {
                    self.i += 1;
                }
                args.push(raw);
            } else {
                args.push(macro_.optional_default.clone().unwrap());
            }
            mandatory -= 1;
        }
        for _ in 0..mandatory {
            self.skip_space();
            args.push(self.read_group_text());
        }
        let mut body = macro_.body.clone();
        for n in (1..=args.len()).rev() {
            body = body.replace(&format!("#{n}"), &args[n - 1]);
        }
        let mut stripped = String::new();
        let mut rest = body.as_str();
        while let Some(idx) = rest.find('$') {
            stripped.push_str(&rest[..idx]);
            rest = &rest[idx + 1..];
            if let Some(end) = rest.find('$') {
                stripped.push_str(&rest[..end]);
                rest = &rest[end + 1..];
            } else {
                break;
            }
        }
        stripped.push_str(rest);
        latex_to_mathml(&stripped, self.macros, self.macro_depth + 1)
    }

    fn attach_brace_limits(&mut self, brace: String) -> String {
        let mut sub: Option<String> = None;
        let mut sup: Option<String> = None;
        while self.i < self.s.len() {
            self.skip_space();
            if self.peek() == Some('_') {
                self.i += 1;
                sub = Some(self.parse_group_or_atom());
                continue;
            }
            if self.peek() == Some('^') {
                self.i += 1;
                sup = Some(self.parse_group_or_atom());
                continue;
            }
            break;
        }
        match (sub, sup) {
            (Some(sub), Some(sup)) => format!("<munderover>{brace}{sub}{sup}</munderover>"),
            (Some(sub), None) => format!("<munder>{brace}{sub}</munder>"),
            (None, Some(sup)) => format!("<mover>{brace}{sup}</mover>"),
            (None, None) => brace,
        }
    }

    fn parse_side_scripts(&self, tex: &str) -> (String, String) {
        let mut p = Parser::new(tex, None, 0);
        let mut sub = "<none/>".to_string();
        let mut sup = "<none/>".to_string();
        while p.i < p.s.len() {
            p.skip_space();
            if p.i >= p.s.len() {
                break;
            }
            if p.peek() == Some('_') {
                p.i += 1;
                let s = p.parse_group_or_atom();
                sub = if s.is_empty() { "<none/>".into() } else { s };
                continue;
            }
            if p.peek() == Some('^') {
                p.i += 1;
                let s = p.parse_group_or_atom();
                sup = if s.is_empty() { "<none/>".into() } else { s };
                continue;
            }
            if p.peek() == Some('\'') {
                p.i += 1;
                let primes = "<mo>′</mo>";
                sup = if sup != "<none/>" {
                    format!("<mrow>{sup}{primes}</mrow>")
                } else {
                    primes.into()
                };
                continue;
            }
            break;
        }
        (sub, sup)
    }

    fn wrap_fences(&self, open: &str, inner: &str, close: Option<&str>) -> String {
        let a = fence_mo(open);
        let b = close.map(fence_mo).unwrap_or_default();
        if a.is_empty() && b.is_empty() {
            return inner.to_string();
        }
        format!("<mrow>{a}{inner}{b}</mrow>")
    }

    fn at_fence_break(&self) -> bool {
        if self.peek() == Some('&') {
            return true;
        }
        if self.starts_lit("\\\\") {
            return true;
        }
        self.starts_command("end")
    }

    fn read_delimiter(&mut self) -> String {
        self.skip_space();
        if self.peek() == Some('.') {
            self.i += 1;
            return String::new();
        }
        if self.peek() == Some('\\') {
            self.i += 1;
            if self.peek().is_some_and(|c| !c.is_ascii_alphabetic()) {
                let ch = self.bump().unwrap();
                if ch == '{' || ch == '}' {
                    return ch.to_string();
                }
                if ch == '.' {
                    return String::new();
                }
                if ch == '|' {
                    return "∥".into();
                }
                return ch.to_string();
            }
            let mut name = String::new();
            while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
                name.push(self.bump().unwrap());
            }
            return match name.as_str() {
                "lvert" | "rvert" | "vert" => "|".into(),
                "lVert" | "rVert" | "Vert" => "∥".into(),
                "langle" => "⟨".into(),
                "rangle" => "⟩".into(),
                "lbrace" => "{".into(),
                "rbrace" => "}".into(),
                "lceil" => "⌈".into(),
                "rceil" => "⌉".into(),
                "lfloor" => "⌊".into(),
                "rfloor" => "⌋".into(),
                "backslash" => "\\".into(),
                _ => lookup_sym_mo(&name).unwrap_or(&name).to_string(),
            };
        }
        self.bump().map(|c| c.to_string()).unwrap_or_default()
    }

    fn read_group_text(&mut self) -> String {
        self.skip_space();
        if self.peek() != Some('{') {
            return String::new();
        }
        self.i += 1;
        let mut depth = 1i32;
        let mut out = String::new();
        while self.i < self.s.len() && depth > 0 {
            let ch = self.bump().unwrap();
            if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            if depth > 0 {
                out.push(ch);
            }
        }
        out
    }

    fn parse_expr_until(&mut self, stop: char) -> String {
        let mut parts: Vec<String> = Vec::new();
        while self.i < self.s.len() && self.peek() != Some(stop) {
            if self.peek() == Some('}') {
                break;
            }
            parts.push(self.parse_with_scripts());
        }
        match parts.len() {
            0 => String::new(),
            1 => parts.remove(0),
            _ => format!("<mrow>{}</mrow>", parts.join("")),
        }
    }

    fn starts_command(&self, name: &str) -> bool {
        if self.peek() != Some('\\') {
            return false;
        }
        let rest = &self.s[self.i + 1..];
        if !rest.starts_with(name) {
            return false;
        }
        !rest[name.len()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
    }

    fn read_color_word(&mut self) -> String {
        self.skip_space();
        let mut name = String::new();
        while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            name.push(self.bump().unwrap());
        }
        name
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t')) {
            self.i += 1;
        }
    }
}
