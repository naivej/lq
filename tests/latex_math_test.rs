//! TeX→MathML (Deno `tests/latex_math_test.ts`).

use lq::{
    MathMacro, MathMacroMap, latex_to_mathml, parse_newcommands, render_formula_html,
    unwrap_latex_source,
};

fn count_pat(hay: &str, pat: &str) -> usize {
    hay.matches(pat).count()
}

#[test]
fn unwrap_latex_source_dollar_equation_label() {
    let u = unwrap_latex_source("$x$");
    assert!(!u.display && !u.numbered && u.env == "$" && u.body == "x");
    let u = unwrap_latex_source("\\begin{equation}\nE=mc^{2}\n\\end{equation}");
    assert!(u.display && u.numbered && u.env == "equation" && u.body == "E=mc^{2}");
    let u = unwrap_latex_source("\\begin{equation}\\ell_{t}(x)\\label{eq:eq_label}\\end{equation}");
    assert!(u.display && u.numbered && u.env == "equation" && u.body == "\\ell_{t}(x)");
    let u = unwrap_latex_source("\\[E=mc^{2}\\]");
    assert!(u.display && !u.numbered && u.env == "[" && u.body == "E=mc^{2}");
    let u = unwrap_latex_source("\\begin{equation*}x\\end{equation*}");
    assert!(u.display && !u.numbered && u.env == "equation*" && u.body == "x");
}

#[test]
fn latex_to_mathml_scripts_greek_sum_delimiters() {
    let html = latex_to_mathml("E=mc^{2}", None, 0);
    assert!(html.contains("<msup><mi>c</mi><mn>2</mn></msup>"), "{html}");
    assert!(latex_to_mathml("\\zeta_{1}(x)", None, 0).contains("<mi>ζ</mi>"));
    let display = latex_to_mathml(
        "\\ell_{t}\\left(x\\right)=\\sum^{K}_{k=1}\\alpha_{k,t}",
        None,
        0,
    );
    assert!(display.contains("<mi>ℓ</mi>"), "{display}");
    assert!(display.contains('∑'), "{display}");
    assert!(display.contains("munderover"), "{display}");
    assert!(
        display.contains("<mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow>"),
        "{display}"
    );
    assert!(!display.contains("stretchy=\"true\""));
    assert!(latex_to_mathml("\\downarrow", None, 0).contains("<mo>↓</mo>"));
    assert!(latex_to_mathml("\\dfrac{A}{B}", None, 0).contains("<mfrac>"));
    assert!(latex_to_mathml("\\nicefrac{1}{18}", None, 0).contains("<mfrac>"));
    assert!(latex_to_mathml("\\mathbf{x}", None, 0).contains("𝐱"));
}

#[test]
fn render_formula_html_escaped() {
    let html = render_formula_html("$a<b$", &[], None);
    assert!(html.contains("<math"), "{html}");
    assert!(html.contains("encoding=\"application/x-tex\""), "{html}");
    assert!(html.contains("a&lt;b"), "{html}");
    assert!(!html.contains("<b>"));
}

#[test]
fn cases_and_pmatrix_mtable() {
    let cases = latex_to_mathml("\\begin{cases}A & B>0\\end{cases}", None, 0);
    assert!(cases.contains("<mtable>"), "{cases}");
    assert!(cases.contains("<mtd>"), "{cases}");
    assert!(cases.contains("<mi>A</mi>"), "{cases}");
    let pmatrix = latex_to_mathml("\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}", None, 0);
    assert!(pmatrix.contains("<mtable>"), "{pmatrix}");
    assert!(pmatrix.contains("<mo>(</mo>"), "{pmatrix}");
    assert!(pmatrix.contains("<mi>a</mi>"), "{pmatrix}");
    assert!(pmatrix.contains("<mi>d</mi>"), "{pmatrix}");
}

#[test]
fn common_symbols_accents_left_array() {
    assert!(latex_to_mathml("\\approx", None, 0).contains('≈'));
    assert!(latex_to_mathml("\\gets", None, 0).contains('←'));
    assert!(latex_to_mathml("\\le", None, 0).contains('≤'));
    assert!(latex_to_mathml("\\varepsilon", None, 0).contains('ε'));
    let ov = latex_to_mathml("\\overrightarrow{a}", None, 0);
    assert!(ov.contains("<mover>"), "{ov}");
    assert!(ov.contains("<mi>a</mi>"), "{ov}");
    let arr = latex_to_mathml(
        "\\left[\\begin{array}{cc}a & b\\\\c & d\\end{array}\\right]",
        None,
        0,
    );
    assert!(arr.contains("<mtable>"), "{arr}");
    assert!(arr.contains("<mi>a</mi>"), "{arr}");
    assert!(arr.contains("<mi>d</mi>"), "{arr}");
    let raised = latex_to_mathml("H\\raisebox{2mm}{al}lo", None, 0);
    assert!(raised.contains("voffset=\"2mm\""), "{raised}");
    assert!(raised.contains("<mi>a</mi>"), "{raised}");
    let boxed = latex_to_mathml("\\colorbox{yellow}{A=B}", None, 0);
    assert!(boxed.contains("mathbackground=\"yellow\""), "{boxed}");
    assert!(boxed.contains("<mi>A</mi>"), "{boxed}");
    let tinted = latex_to_mathml("\\textcolor{red}{\\int A=B}", None, 0);
    assert!(tinted.contains("mathcolor=\"red\""), "{tinted}");
    assert!(tinted.contains('∫'), "{tinted}");
    let brack = latex_to_mathml("{A \\brack B}", None, 0);
    assert!(brack.contains("<mfrac"), "{brack}");
    assert!(brack.contains("<mo>[</mo>"), "{brack}");
    assert!(latex_to_mathml("a\\pmod b", None, 0).contains("mod"));
    assert!(latex_to_mathml("\\Bra{\\psi}", None, 0).contains('⟨'));
    assert!(latex_to_mathml("\\cancel{x}", None, 0).contains("updiagonalstrike"));
    assert!(latex_to_mathml("\\underbar{a}", None, 0).contains("notation=\"bottom\""));
    let aligned = latex_to_mathml("\\begin{aligned}A&=B\\\\C&=D\\end{aligned}", None, 0);
    assert!(aligned.contains("<mtable>"), "{aligned}");
    assert!(aligned.contains("<mi>C</mi>"), "{aligned}");
    let tagged = render_formula_html(
        "\\begin{equation}A+B=C\\tag{something}\\end{equation}",
        &[Some("9")],
        None,
    );
    assert!(tagged.contains("(something)"), "{tagged}");
    assert!(!tagged.contains("(9)"));
    let unnumbered = render_formula_html("\\[E=mc^{2}\\]", &[Some("5")], None);
    assert!(unnumbered.contains("display=\"block\""), "{unnumbered}");
    assert!(!unnumbered.contains("(5)"));
    let numbered = render_formula_html(
        "\\begin{equation}E=mc^{2}\\end{equation}",
        &[Some("3")],
        None,
    );
    assert!(numbered.contains("(3)"), "{numbered}");
    let gather = render_formula_html(
        "\\begin{gather}A=1\\\\ X=\\textrm{-}1\\end{gather}",
        &[Some("8"), Some("9")],
        None,
    );
    assert_eq!(count_pat(&gather, "class=\"formula-row\""), 2);
    assert_eq!(count_pat(&gather, "display=\"block\""), 2);
    assert!(gather.contains("(8)"), "{gather}");
    assert!(gather.contains("(9)"), "{gather}");
    assert!(gather.find("(8)").unwrap() < gather.find("(9)").unwrap());
    assert!(gather.contains("<mi>A</mi>"));
    assert!(gather.contains("<mn>1</mn>"));
    let eqnarray = render_formula_html(
        "\\begin{eqnarray}A&=&B\\\\ C&=&D\\nonumber \\\\ E&=&F\\end{eqnarray}",
        &[Some("1"), None, Some("2")],
        None,
    );
    assert_eq!(count_pat(&eqnarray, "class=\"formula-row\""), 3);
    assert!(eqnarray.contains("(1)"));
    assert!(eqnarray.contains("(2)"));
    assert_eq!(count_pat(&eqnarray, "class=\"eqno\""), 2);
    let multline = render_formula_html(
        "\\begin{multline}A\\\\ B\\\\ C\\end{multline}",
        &[None, None, Some("4")],
        None,
    );
    assert_eq!(count_pat(&multline, "class=\"formula-row\""), 3);
    assert!(multline.contains("(4)"));
    assert_eq!(count_pat(&multline, "class=\"eqno\""), 1);
    let xl = latex_to_mathml("F(a)\\xleftarrow[x>0]{x=a}F(x)", None, 0);
    assert!(xl.contains("<munderover>"), "{xl}");
    assert!(xl.contains("<mi>x</mi>"), "{xl}");
    let cd = latex_to_mathml(
        "\\begin{CD}A@>>>B@>>>C\\\\@AAA@.@VVV\\\\F@<<<E@<<<D\\end{CD}",
        None,
        0,
    );
    assert!(cd.contains("<mtable"), "{cd}");
    assert!(cd.contains("<mi>A</mi>"), "{cd}");
    assert!(cd.contains("<mi>F</mi>"), "{cd}");
    assert!(cd.contains('→'), "{cd}");
    assert!(cd.contains('↑'), "{cd}");
    let script = latex_to_mathml("{\\scriptstyle E=mc^{2}}", None, 0);
    assert!(script.contains("mathsize=\"75%\""), "{script}");
    assert!(script.contains("<mi>E</mi>"), "{script}");
    let gf = latex_to_mathml("\\genfrac{(}{)}{0pt}{1}{A}{B}", None, 0);
    assert!(gf.contains("linethickness=\"0\""), "{gf}");
    assert!(gf.contains("<mo>(</mo>"), "{gf}");
}

#[test]
fn unknown_commands_stay_visible() {
    let html = latex_to_mathml("\\unknown{x}", None, 0);
    assert!(!html.contains("<script"));
    assert!(html.contains("unknown"), "{html}");
}

#[test]
fn smashoperator_optional_brace_phantom_sideset_ce() {
    let smash = latex_to_mathml("\\smashoperator{\\sum^{n}_{i=1}}X", None, 0);
    assert!(smash.contains('∑'), "{smash}");
    assert!(!smash.contains("smashoperator"));
    let cfrac = latex_to_mathml("\\cfrac[l]{A}{B+C}", None, 0);
    assert!(cfrac.contains("<mfrac>"), "{cfrac}");
    assert!(cfrac.contains("<mi>A</mi>"), "{cfrac}");
    assert!(!cfrac.contains("<mo>[</mo>"));
    let over = latex_to_mathml("\\overbrace{A+B}^{3}", None, 0);
    assert!(over.contains("<mover>"), "{over}");
    assert!(over.contains('⏞'), "{over}");
    assert!(!over.contains("<msup><mover>"));
    let under = latex_to_mathml("\\underbrace{A+B}_{5}", None, 0);
    assert!(under.contains("<munder>"), "{under}");
    assert!(under.contains('⏟'), "{under}");
    assert!(!under.contains("<msub><munder>"));
    let bracket = latex_to_mathml("\\overbracket[3pt]{A+B}", None, 0);
    assert!(bracket.contains("<mover>"), "{bracket}");
    assert!(bracket.contains("<mi>A</mi>"), "{bracket}");
    assert!(!bracket.contains("<mn>3</mn>"));
    let phant = latex_to_mathml("^{19}_{\\phantom{1}9}", None, 0);
    assert!(phant.contains("<mphantom>"), "{phant}");
    assert!(phant.contains("<mn>1</mn>"), "{phant}");
    let side = latex_to_mathml("\\sideset{}{'}\\sum^{n}_{k=1}", None, 0);
    assert!(side.contains("mmultiscripts"), "{side}");
    assert!(side.contains('′'), "{side}");
    let ce = latex_to_mathml("\\ce{SO4^{2-}}", None, 0);
    assert!(ce.contains("<msub>"), "{ce}");
    assert!(ce.contains("<msup>"), "{ce}");
    assert!(!ce.contains("SO4^{2-}"));
    let arrow = latex_to_mathml("\\ce{A -> B}", None, 0);
    assert!(arrow.contains("<mo>→</mo>"), "{arrow}");
    let bonds = latex_to_mathml("\\ce{A-B\\dbond C\\tbond D}", None, 0);
    assert!(bonds.contains("<mo>=</mo>"), "{bonds}");
    assert!(bonds.contains("<mo>≡</mo>"), "{bonds}");
    assert!(!bonds.contains("\\dbond"));
    let hyphen = latex_to_mathml("\\ce{\\ensuremath{\\mu\\hyphen}Cl}", None, 0);
    assert!(hyphen.contains('μ'), "{hyphen}");
    assert!(!hyphen.contains("\\hyphen"));
}

#[test]
fn preamble_newcommand_macros() {
    let macros = parse_newcommands(
        r"
\newcommand{\gr}{\Longrightarrow}
\newcommand{\us}[1]{\underline{#1}}
\newcommand{\fb}[3]{\framebox#1#2{$#3$}}
\newcommand{\cb}[3][white]{\fcolorbox{#2}{#1}{$#3$}}
",
    );
    assert!(latex_to_mathml("A\\gr B", Some(&macros), 0).contains('⟹'));
    assert!(!latex_to_mathml("A\\gr B", Some(&macros), 0).contains("\\gr"));
    let us = latex_to_mathml("\\us{ABcd}", Some(&macros), 0);
    assert!(us.contains("notation=\"bottom\""), "{us}");
    assert!(!us.contains("<mo>_</mo>"));
    assert!(!us.contains("\\us"));
    let cb = latex_to_mathml("\\cb{red}{\\int A=B}", Some(&macros), 0);
    assert!(cb.contains("border:2px solid red"), "{cb}");
    assert!(cb.contains('∫'), "{cb}");
    assert!(!cb.contains("\\cb"));
    let cb2 = latex_to_mathml("\\cb[green]{red}{\\int A=B}", Some(&macros), 0);
    assert!(cb2.contains("border:2px solid red"), "{cb2}");
    assert!(cb2.contains("mathbackground=\"green\""), "{cb2}");
    let fb = latex_to_mathml("\\fb{[2cm]}{}{\\int A=B}", Some(&macros), 0);
    assert!(fb.contains("menclose"), "{fb}");
    assert!(fb.contains('∫'), "{fb}");
    assert!(latex_to_mathml("\\underline{ABcd}", None, 0).contains("notation=\"bottom\""));
}

#[test]
fn cyclic_macros_fall_back() {
    let mut macros = MathMacroMap::new();
    macros.insert(
        "a".into(),
        MathMacro {
            nargs: 0,
            optional_default: None,
            body: "\\b".into(),
        },
    );
    macros.insert(
        "b".into(),
        MathMacro {
            nargs: 0,
            optional_default: None,
            body: "\\a".into(),
        },
    );
    let out = latex_to_mathml("\\a", Some(&macros), 0);
    assert!(out.len() < 2000, "{out}");
    assert!(out.contains("\\a"), "{out}");
}

fn letter_name(mut n: i32) -> String {
    let mut out = String::new();
    loop {
        out.insert(0, char::from(97 + (n % 26) as u8));
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    out
}

#[test]
fn deep_macro_chains_cap_depth() {
    let mut macros = MathMacroMap::new();
    for i in 0..80 {
        macros.insert(
            letter_name(i),
            MathMacro {
                nargs: 0,
                optional_default: None,
                body: format!("\\{}", letter_name(i + 1)),
            },
        );
    }
    macros.insert(
        letter_name(80),
        MathMacro {
            nargs: 0,
            optional_default: None,
            body: "x".into(),
        },
    );
    let out = latex_to_mathml(&format!("\\{}", letter_name(0)), Some(&macros), 0);
    assert!(out.contains(&format!("\\{}", letter_name(64))), "{out}");
    assert!(!out.contains(&format!("\\{}", letter_name(80))));
}

#[test]
fn gui_math_fonts() {
    let ds = latex_to_mathml("\\mathds{1}", None, 0);
    assert!(ds.contains('𝟙'), "{ds}");
    assert!(!ds.contains("mathvariant"));
    assert!(latex_to_mathml("\\mathbb{N}", None, 0).contains('ℕ'));
    assert!(latex_to_mathml("\\mathbf{x}", None, 0).contains("𝐱"));
    assert!(latex_to_mathml("\\boldsymbol{x}", None, 0).contains("𝒙"));
    assert!(latex_to_mathml("\\mathsf{A}", None, 0).contains("𝖠"));
    assert!(latex_to_mathml("\\mathtt{A}", None, 0).contains("𝙰"));
    assert!(latex_to_mathml("\\mathcal{F}", None, 0).contains('ℱ'));
    assert!(latex_to_mathml("\\mathscr{F}", None, 0).contains('ℱ'));
    assert!(latex_to_mathml("\\mathfrak{R}", None, 0).contains('ℜ'));
    assert!(latex_to_mathml("\\mathit{a}", None, 0).contains("<mi>a</mi>"));
    let roman = latex_to_mathml("\\mathrm{d}", None, 0);
    assert!(roman.contains("mathvariant=\"normal\""), "{roman}");
    assert!(roman.contains(">d</mi>"), "{roman}");
    let normal = latex_to_mathml("\\mathnormal{a}", None, 0);
    assert!(normal.contains("<mi>a</mi>"), "{normal}");
    assert!(!normal.contains("mathvariant"));
    assert!(latex_to_mathml("\\mathds{?}", None, 0).contains('?'));
    let words = latex_to_mathml("\\textrm{a b}", None, 0);
    assert!(words.contains("<mtext>a b</mtext>"), "{words}");
    assert!(latex_to_mathml("\\textbf{x}", None, 0).contains("style=\"font-weight:bold\""));
    assert!(latex_to_mathml("\\textit{x}", None, 0).contains("style=\"font-style:italic\""));
    assert!(latex_to_mathml("\\textsl{x}", None, 0).contains("style=\"font-style:italic\""));
    assert!(latex_to_mathml("\\textsf{x}", None, 0).contains("style=\"font-family:sans-serif\""));
    assert!(latex_to_mathml("\\texttt{x}", None, 0).contains("style=\"font-family:monospace\""));
    assert!(latex_to_mathml("\\textsc{x}", None, 0).contains("style=\"font-variant:small-caps\""));
    assert!(latex_to_mathml("\\textnormal{x}", None, 0).contains("<mtext>x</mtext>"));
    assert!(latex_to_mathml("\\textmd{x}", None, 0).contains("<mtext>x</mtext>"));
    assert!(latex_to_mathml("\\textup{x}", None, 0).contains("<mtext>x</mtext>"));
}

#[test]
fn brace_fences_and_left_right_at_matrix_breaks() {
    let bare = latex_to_mathml("\\{x\\}", None, 0);
    assert!(bare.contains("<mo>{</mo>"), "{bare}");
    assert!(bare.contains("<mo>}</mo>"), "{bare}");
    assert!(!bare.contains("<mi>{</mi>"));
    let paired = latex_to_mathml("\\left\\{ x \\right\\}", None, 0);
    assert!(paired.contains("<mo>{</mo>"), "{paired}");
    assert!(paired.contains("<mo>}</mo>"), "{paired}");
    assert!(!paired.contains("<mo>\\</mo>"));
    let invisible = latex_to_mathml("\\left. x \\right\\}", None, 0);
    assert!(invisible.contains("<mo>}</mo>"), "{invisible}");
    assert!(!invisible.contains("<mo>.</mo>"));
    let named = latex_to_mathml("\\left\\lbrace x \\right\\rbrace", None, 0);
    assert!(named.contains("<mo>{</mo>"), "{named}");
    assert!(named.contains("<mo>}</mo>"), "{named}");
    let inatt = latex_to_mathml(
        "\\begin{array}{cc}A & \\left\\{ x \\right.\\\\ & \\left. y \\right\\}\\end{array}",
        None,
        0,
    );
    assert_eq!(count_pat(&inatt, "<mtr>"), 2);
    assert!(inatt.contains("<mo>{</mo>"), "{inatt}");
    assert!(inatt.contains("<mo>}</mo>"), "{inatt}");
    assert!(inatt.contains("<mi>x</mi>"), "{inatt}");
    assert!(inatt.contains("<mi>y</mi>"), "{inatt}");
    assert!(!inatt.contains("<mo>\\</mo>"));
    let split_row = latex_to_mathml(
        "\\begin{array}{c}\\left\\{ a \\\\ b \\right.\\end{array}",
        None,
        0,
    );
    assert_eq!(count_pat(&split_row, "<mtr>"), 2);
    assert!(split_row.contains("<mo>{</mo>"), "{split_row}");
    assert!(split_row.contains("<mi>a</mi>"), "{split_row}");
    assert!(split_row.contains("<mi>b</mi>"), "{split_row}");
    assert!(!split_row.contains("<mo>.</mo>"));
    let split_col = latex_to_mathml(
        "\\begin{array}{cc}\\left( a & b \\right)\\end{array}",
        None,
        0,
    );
    assert_eq!(count_pat(&split_col, "<mtd>"), 2);
    assert!(split_col.contains("<mo>(</mo>"), "{split_col}");
    assert!(split_col.contains("<mo>)</mo>"), "{split_col}");
    assert!(split_col.contains("<mi>a</mi>"), "{split_col}");
    assert!(split_col.contains("<mi>b</mi>"), "{split_col}");
}
