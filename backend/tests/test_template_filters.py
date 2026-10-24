from note_rendering import render_template


def test_type_answer_escaping_and_cloze():
    front = render_template('{{type:Back}}', {'Back': '<b>A & "B"</b>'})
    assert 'data-type-field="Back"' in front
    assert 'A &amp; &quot;B&quot;' in front
    typed = render_template('{{type:cloze:Text}}', {'Text': '{{c1::one}} {{c2::two}} {{c1::one}} {{c1::three}}'}, answer=True)
    assert 'data-type-answer="one, three"' in typed


def test_ruby_filters_preserve_html():
    fields = {'Word': '<b title="x[y]">日本語[にほんご]</b>'}
    assert render_template('{{furigana:Word}}', fields) == '<b title="x[y]"><ruby>日本語<rt>にほんご</rt></ruby></b>'
    assert render_template('{{kana:Word}}', fields) == '<b title="x[y]">にほんご</b>'
    assert render_template('{{kanji:Word}}', fields) == '<b title="x[y]">日本語</b>'
    assert render_template('{{hint:Word}}', {'Word': ''}) == ''
