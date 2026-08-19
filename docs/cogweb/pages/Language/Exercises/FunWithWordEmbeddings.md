---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.7
  nbsphinx:
    execute: never
---

<!-- #region -->
# Fun With Word Embeddings

Word embeddings (or "word vectors") are mappings from discrete word tokens (e.g., the word "kitten") to numerical vectors, e.g., a 50-dimensional vector of real numbers. The goal is for words that are related (such as "scared" and "afraid") to map to points that are close together in the 50-dimensional space.

These continous representations for words have proven very helpful in many NLP tasks. For example, they can help deal with synonyms that would otherwise have been considered totally unrelated in the bag of words approach to representing documents.

There are several approaches for finding such an embedding. One approach is to analyze the contexts that words appear in over a large corpus and then find embeddings that map words with similar contexts to similar points in the space. For example,

    I am scared of dogs.
    I am scared of bees.
    I am afraid of dogs.
    I am afraid of bees.
    ...

The words "scared" and "afraid" both appear in the contexts

    "I am ... of dogs"

and

    "I am ... of bees"

so it's likely that the words are related in some way. The relationship can be semantic (related to meaning) or syntactic (e.g., often occur between a determiner and a noun) In this case, "scared" and "afraid" are related semantically (similar meaning) and also syntactically (both adjectives).

One really neat thing that researchers discovered is that word embeddings can be used to solve analogies, e.g., 

    "puppy" is to "dog" as "kitten" is to ?
    
Amazingly, this kind of puzzle can be solved by doing computations on word vectors:

```python
wv["kitten"] - wv["puppy"] + wv["dog"]
```
<!-- #endregion -->
and finding the most similar word to the result, `wv["cat"]` in this case.

The reason is that the vector `(wv["dog"] - wv["puppy"])` represents a direction in the space the often takes the youth version of a concept to the adult version. So starting with "kitten" and moving in that direction winds up in an area of the space similar to "cat".


## 0 Imports

```python
from collections import defaultdict
import numpy as np
import time
import gensim
from gensim.models.keyedvectors import KeyedVectors
from sklearn.decomposition import TruncatedSVD
import matplotlib.pyplot as plt
%matplotlib inline
```

## 1 Load pre-trained GloVe embeddings using gensim library

The [gensim](https://radimrehurek.com/gensim/) library is a great tool for working with word embeddings and doing other things with text (like analyzing latent topics). If you need to install gensim, try: 

    pip install gensim

We're going to use gensim to explore some pre-trained word embeddings trained with an algorithm called [GloVe](https://nlp.stanford.edu/projects/glove/).

The following code will now use gensim to load the word vectors into a variable called `glove`.

```python
from collections import defaultdict
import numpy as np
import time
import gensim
from gensim.models.keyedvectors import KeyedVectors
from sklearn.decomposition import TruncatedSVD
import matplotlib.pyplot as plt

from cogworks_data.language import get_data_path

%matplotlib inline

path = get_data_path("glove.6B.50d.txt.w2v")

t0 = time.time()
glove = KeyedVectors.load_word2vec_format(path, binary=False)
t1 = time.time()
print("elapsed %ss" % (t1 - t0))
# 50d: elapsed 17.67420792579651s
# 100d: 
```

You can get the word vector for a word (string) with the following: 
```python
glove["word"]
```
Print out the word vector for your favorite word. Note: you can check that the word is in the 400K lowercased vocabulary with:
```python
"word" in glove
```
What's the type of the word vector (e.g. a numpy array, a tuple)? What's its shape?

```python
# <COGINST>
v = glove["rose"]
print(v)
print(type(v))
print(v.shape)
# </COGINST>
```


It's not clear how to (or even if we can) interpret what the individual dimensions mean. But we can gain some intuition by looking at the relationships between whole word vectors.


## 2 Finding most similar words

You can use
```python
glove.most_similar("word")
```
to find the words that the model considers most similar to a specified word (according to cosine similarity). Try it out on "funny" and "pencil" and some other words.


```python
# <COGINST>
print(glove.most_similar("funny"))
glove.most_similar("pencil")
# </COGINST>
```

What do you notice about the relationships of the similars words to the query word? Are they all the same part of speech (e.g., all adjectives or all verbs)? Are they synonyms or near synonyms? Are they all objects of the same type (e.g., all tools)?

<!-- #region -->
## 3 Visualization through dimensionality reduction

It's difficult to visualize high-dimensional data like the 50-dimensional GloVe embeddings. So we're going to use (truncated) Singular Value Decomposition (SVD) to reduce the dimensions down to 2, which we can then easily plot.

We'll be using scikit-learn's `TruncatedSVD` implementation. When creating the object, you provide the number of desired dimensions, e.g.,

```python
svd = TruncatedSVD(n_components=2)
```

Then you fit the dimensionality reduction model to data with:

```python
svd.fit(X_train)
```

Finally, to transform a 50-dimensional matrix (or single vector) down to 2-dimensions according to the model, you call:

```python
X_reduced = svd.transform(X)
```
<!-- #endregion -->
### Get all embeddings into a matrix

First, we'll copy all of the word embeddings into a single matrix. Note: It's a little wasteful to have loaded the embeddings using gensim (which is storing them internally already) and then copying them into a numpy array in order to apply dimensionality reduction. But it was handy to use gensim for loading and for some of it's convenient lookup methods...

```python
n = len(glove.key_to_index)
d = glove.vector_size
X_glove = np.zeros((n, d))
for i, word in enumerate(glove.key_to_index.keys()):
    X_glove[i,:] = glove[word]
print(X_glove.nbytes)
```

### Fit `TruncatedSVD` on the `X_glove` matrix.

```python
# <COGINST>
t0 = time.time()
svd = TruncatedSVD(n_components=2)
svd.fit(X_glove)
t1 = time.time()
print("elapsed %ss" % (t1 - t0))
# </COGINST>
```

The following helper function will help us visualize word pairs in the reduced 2-dimensional version of the word embedding space:

```python
def plot_pairs(words, word_vectors, svd):
    """ Plots pairs of words in 2D.
    
    Parameters
    ----------
    words: list[str]
        A list with an even number of words, where pairs of words have some common relationship
        (like profession and tool), e.g., ["carpenter", "hammer", "plumber", "wrench"].
        
    word_vectors: KeyedVectors instance
        A word embedding model in gensim's KeyedVectors wrapper.
        
    svd: TruncatedSVD instance
        A truncated SVD instance that's already been fit (with n_components=2).
    """

    # map specified words to 2D space
    d = word_vectors.vector_size
    words_temp = np.zeros((len(words), d))
    for i, word in enumerate(words):
        words_temp[i,:] = word_vectors[word]
    words_2D = svd.transform(words_temp)

    # plot points
    plt.scatter(words_2D[:,0], words_2D[:,1])
    
    # plot labels
    for i, txt in enumerate(words):
        plt.annotate(txt, (words_2D[i, 0], words_2D[i, 1]))

    # plot lines
    for i in range(int(len(words)/2)):
        plt.plot(words_2D[i*2:i*2+2,0], words_2D[i*2:i*2+2,1], linestyle='dashed', color='k')
```

### Visualize: Male vs Female

Try plotting these pairs and then adding some more to see how consistent the relationship is.

```python
words = ["man", "woman", "king", "queen", "uncle", "aunt", "nephew", "niece", "brother", "sister", "sir", "madam"]
plot_pairs(words, glove, svd)
```

### Visualize: Adjective vs Comparative

Try plotting these pairs and then adding some more to see how consistent the relationship is.

```python
words = ["short", "shorter", "strong", "stronger", "good", "better"]
plot_pairs(words, glove, svd)
```

### Visualize: Cellular Biology Metaphors

Try plotting these pairs and then adding some more to see how consistent the relationship is.

```python
words = ["mitochondria", "cell", "powerhouse", "town"]
plot_pairs(words, glove, svd)
```

## 4 Introduction to Analogies

Let's try applying word embeddings to solve analogies of the form: $a$ is to $b$ as $c$ is to ?

We'll exploit the directions in the embedding space by finding the closest vector to $c + (b - a)$, or equivalently $c - a + b$.

A common example is: "puppy" is to "dog" as "kitten" is to ?

This can be solved by finding the closest vector to: "kitten" - "puppy" + "dog".

```python
query = glove["kitten"] - glove["puppy"] + glove["dog"]
glove.similar_by_vector(query)
```

Note that the most similar word (other than "dog" itself) is "cat"!

Now try solving: "france" is to "paris" as "germany" is to ?

```python
# <COGINST>
query = glove["paris"] - glove["france"] + glove["germany"]
glove.similar_by_vector(query)
# </COGINST>
```

<!-- #region -->
Note that the gensim library has convenience methods for doing analogies. For example,

"kitten" - "puppy" + "dog"

can be solved with:

```python
glove.most_similar_cosmul(positive=['kitten', 'dog'], negative=['puppy'])
```

This uses a slightly more advanced technique for solving analogies that has "less susceptibility to one large distance dominating the calculation". See most_similar_cosmul() documentation for more details.
<!-- #endregion -->

```python
glove.most_similar_cosmul(positive=['kitten', 'dog'], negative=['puppy'])
```

Try experimenting with some other kinds of word relationships (e.g., plurals, ing forms, etc.).
